module.exports = {
  context: __dirname,
  entry: './index',
  output: {
    path: 'dist',
    filename: 'bundle.js'
  },
  devtool: 'source-map',
  module: {
    loaders: [
      { test: /.*\.js$/, exclude: /node_modules/, loader: 'babel?presets[]=es2015' },
      { test: /\.css$/, loader: 'style!css' }
    ]
  }
}
