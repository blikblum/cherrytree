import { pick, clone, extend, isEqual, isString } from './dash'
import functionDsl from './function-dsl'
import arrayDsl from './array-dsl'
import { withQuery, withoutQuery, injectParams, extractParams, extractParamNames, extractQuery } from './path'
import invariant from './invariant'
import BrowserLocation from './locations/browser'
import MemoryLocation from './locations/memory'
import transition from './transition'
import { intercept } from './links'
import createLogger from './logger'
import qs from './qs'
import { TRANSITION_CANCELLED, TRANSITION_REDIRECTED } from './constants'

function Cherrytree (options = {}) {
  this.nextId = 1
  this.state = {}
  this.middleware = []
  this.options = extend({
    location: 'browser',
    interceptLinks: true,
    logError: true,
    qs: qs
  }, options)
  this.log = createLogger(this.options.log)
  this.logError = createLogger(this.options.logError, { error: true })
  if (options.routes) {
    this.map(options.routes)
  }
}

/**
 * Add a middleware
 * @param  {Function} middleware
 * @return {Object}   router
 * @api public
 */
Cherrytree.prototype.use = function (middleware) {
  const m = typeof middleware === 'function' ? { next: middleware } : middleware
  this.middleware.push(m)
  return this
}

/**
 * Add the route map
 * @param  {Function} routes
 * @return {Object}   router
 * @api public
 */
Cherrytree.prototype.map = function (routes) {
  // create the route tree
  this.routes = Array.isArray(routes) ? arrayDsl(routes) : functionDsl(routes)

  // create the matcher list, which is like a flattened
  // list of routes = a list of all branches of the route tree
  let matchers = this.matchers = []
  // keep track of whether duplicate paths have been created,
  // in which case we'll warn the dev
  let dupes = {}
  // keep track of abstract routes to build index route forwarding
  let abstracts = {}

  eachBranch({ routes: this.routes }, [], function (routes) {
    // concatenate the paths of the list of routes
    let path = routes.reduce(function (memo, r) {
      // reset if there's a leading slash, otherwise concat
      // and keep resetting the trailing slash
      return (r.path[0] === '/' ? r.path : memo + '/' + r.path).replace(/\/$/, '')
    }, '')
    // ensure we have a leading slash
    if (path === '') {
      path = '/'
    }

    let lastRoute = routes[routes.length - 1]

    if (lastRoute.options.abstract) {
      abstracts[path] = lastRoute.name
      return
    }

    // register routes
    matchers.push({
      routes: routes,
      name: lastRoute.name,
      path: path
    })

    // dupe detection
    if (dupes[path]) {
      throw new Error('Routes ' + dupes[path] + ' and ' + lastRoute.name +
      ' have the same url path \'' + path + '\'')
    }
    dupes[path] = lastRoute.name
  })

  // check if there is an index route for each abstract route
  Object.keys(abstracts).forEach(function (path) {
    let matcher
    if (!dupes[path]) return

    matchers.some(function (m) {
      if (m.path === path) {
        matcher = m
        return true
      }
    })

    matchers.push({
      routes: matcher.routes,
      name: abstracts[path],
      path: path
    })
  })

  function eachBranch (node, memo, fn) {
    node.routes.forEach(function (route) {
      fn(memo.concat(route))

      if (route.routes.length) {
        eachBranch(route, memo.concat(route), fn)
      }
    })
  }

  return this
}

/**
 * Starts listening to the location changes.
 * @param  {Object}  location (optional)
 * @return {Promise} initial transition
 *
 * @api public
 */
Cherrytree.prototype.listen = function (path) {
  let location = this.location = this.createLocation(path || '')
  // setup the location onChange handler
  location.onChange((url) => {
    let previousUrl = this.state.path
    this.dispatch(url).catch((err) => {
      if (err && err.type === TRANSITION_CANCELLED) {
        // reset the URL in case the transition has been cancelled
        this.location.replaceURL(previousUrl, { trigger: false })
      }
      return err
    })
  })
  // start intercepting links
  if (this.options.interceptLinks && location.usesPushState()) {
    this.interceptLinks()
  }
  // and also kick off the initial transition
  return this.dispatch(location.getURL())
}

/**
 * Transition to a different route. Passe in url or a route name followed by params and query
 * @param  {String} url     url or route name
 * @param  {Object} params  Optional
 * @param  {Object} query   Optional
 * @return {Object}         transition
 *
 * @api public
 */
Cherrytree.prototype.transitionTo = function (...args) {
  if (this.state.activeTransition) {
    return this.replaceWith.apply(this, args)
  }
  return this.doTransition('setURL', args)
}

/**
 * Like transitionTo, but doesn't leave an entry in the browser's history,
 * so clicking back will skip this route
 * @param  {String} url     url or route name followed by params and query
 * @param  {Object} params  Optional
 * @param  {Object} query   Optional
 * @return {Object}         transition
 *
 * @api public
 */
Cherrytree.prototype.replaceWith = function (...args) {
  return this.doTransition('replaceURL', args)
}

/**
 * Create an href
 * @param  {String} name   target route name
 * @param  {Object} params
 * @param  {Object} query
 * @return {String}        href
 *
 * @api public
 */
Cherrytree.prototype.generate = function (name, params, query) {
  invariant(this.location, 'call .listen() before using .generate()')
  let matcher

  query = query || {}

  this.matchers.forEach(function (m) {
    if (m.name === name) {
      matcher = m
    }
  })

  if (!matcher) {
    throw new Error('No route is named ' + name)
  }

  let url = withQuery(this.options.qs, injectParams(matcher.path, params), query)
  return this.location.formatURL(url)
}

/**
 * Stop listening to URL changes
 * @api public
 */
Cherrytree.prototype.destroy = function () {
  if (this.location && this.location.destroy) {
    this.location.destroy()
  }
  if (this.disposeIntercept) {
    this.disposeIntercept()
  }
  if (this.state.activeTransition) {
    this.state.activeTransition.cancel()
  }
  this.state = {}
}

/**
 * Check if the given route/params/query combo is active
 * @param  {String} name   target route name
 * @param  {Object} params
 * @param  {Object} query
 * @return {Boolean}
 *
 * @api public
 */
Cherrytree.prototype.isActive = function (name, params, query) {
  params = params || {}
  query = query || {}

  let activeRoutes = this.state.routes || []
  let activeParams = this.state.params || {}
  let activeQuery = this.state.query || {}

  let isActive = activeRoutes.some(route => route.name === name)
  isActive = isActive && Object.keys(params).every(key => activeParams[key] === params[key])
  isActive = isActive && Object.keys(query).every(key => activeQuery[key] === query[key])

  return isActive
}

/**
 * @api private
 */
Cherrytree.prototype.doTransition = function (method, params) {
  let previousUrl = this.location.getURL()

  let url = params[0]
  if (url[0] !== '/') {
    url = this.generate.apply(this, params)
    url = url.replace(/^#/, '/')
  }

  if (this.options.pushState) {
    url = this.location.removeRoot(url)
  }

  let transition = this.dispatch(url)

  transition.catch((err) => {
    if (err && err.type === TRANSITION_CANCELLED) {
      // reset the URL in case the transition has been cancelled
      this.location.replaceURL(previousUrl, { trigger: false })
    }
    return err
  })

  this.location[method](url, { trigger: false })

  return transition
}

/**
 * Match the path against the routes
 * @param  {String} path
 * @return {Object} the list of matching routes and params
 *
 * @api private
 */
Cherrytree.prototype.match = function (path) {
  path = (path || '').replace(/\/$/, '') || '/'
  let params
  let routes = []
  let pathWithoutQuery = withoutQuery(path)
  let qs = this.options.qs
  this.matchers.some(function (matcher) {
    params = extractParams(matcher.path, pathWithoutQuery)
    if (params) {
      routes = matcher.routes
      return true
    }
  })
  return {
    routes: routes.map(descriptor),
    params: params || {},
    pathname: pathWithoutQuery,
    query: extractQuery(qs, path) || {}
  }

  // clone the data (only a shallow clone of options)
  // to make sure the internal route store is not mutated
  // by the middleware. The middleware can mutate data
  // before it gets passed into the next middleware, but
  // only within the same transition. New transitions
  // will get to use pristine data.
  function descriptor (route) {
    return {
      name: route.name,
      path: route.path,
      params: pick(params, extractParamNames(route.path)),
      options: clone(route.options)
    }
  }
}

Cherrytree.prototype.dispatch = function (path) {
  let match = this.match(path)
  let query = match.query
  let pathname = match.pathname

  let activeTransition = this.state.activeTransition

  // if we already have an active transition with all the same
  // params - return that and don't do anything else
  if (activeTransition &&
      activeTransition.pathname === pathname &&
      isEqual(activeTransition.query, query)) {
    return activeTransition
  }

  // otherwise, cancel the active transition since we're
  // redirecting (or initiating a brand new transition)
  if (activeTransition) {
    let err = new Error(TRANSITION_REDIRECTED)
    err.type = TRANSITION_REDIRECTED
    err.nextPath = path
    activeTransition.cancel(err)
  }

  // if there is no active transition, check if
  // this is a noop transition, in which case, return
  // a transition to respect the function signature,
  // but don't actually run any of the middleware
  if (!activeTransition) {
    if (this.state.pathname === pathname &&
        isEqual(this.state.query, query)) {
      return transition({
        id: this.nextId++,
        path: path,
        match: match,
        noop: true,
        router: this
      })
    }
  }

  let t = transition({
    id: this.nextId++,
    path: path,
    match: match,
    router: this
  })

  this.state.activeTransition = t

  return t
}

/**
 * Create the default location.
 * This is used when no custom location is passed to
 * the listen call.
 * @return {Object} location
 *
 * @api private
 */
Cherrytree.prototype.createLocation = function (path) {
  let location = this.options.location
  if (!isString(location)) {
    return location
  }
  if (location === 'browser') {
    return new BrowserLocation(pick(this.options, ['pushState', 'root']))
  } else if (location === 'memory') {
    return new MemoryLocation({ path })
  } else {
    throw new Error('Location can be `browser`, `memory` or a custom implementation')
  }
}

/**
 * When using pushState, it's important to setup link interception
 * because all link clicks should be handled via the router instead of
 * browser reloading the page
 */
Cherrytree.prototype.interceptLinks = function () {
  let clickHandler = typeof this.options.interceptLinks === 'function'
    ? this.options.interceptLinks
    : defaultClickHandler
  this.disposeIntercept = intercept((event, link) => clickHandler(event, link, this))

  function defaultClickHandler (event, link, router) {
    event.preventDefault()
    router.transitionTo(router.location.removeRoot(link.getAttribute('href')))
  }
}

export default Cherrytree
