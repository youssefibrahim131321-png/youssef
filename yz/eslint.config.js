// (إصلاح 13) lint حقيقي للمشروع: سيرفر (CommonJS/Node) + واجهة (متصفح).
module.exports = [
  {
    files: ['**/*.js'],
    ignores: ['node_modules/**', 'data/**', 'public/service-worker.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly', module: 'writable', process: 'readonly', __dirname: 'readonly',
        console: 'readonly', Buffer: 'readonly', setTimeout: 'readonly', setInterval: 'readonly',
        clearTimeout: 'readonly', clearInterval: 'readonly', URL: 'readonly', TextEncoder: 'readonly',
        fetch: 'readonly', AbortSignal: 'readonly', AbortController: 'readonly', Headers: 'readonly', Response: 'readonly', Request: 'readonly', File: 'readonly', FormData: 'readonly', Blob: 'readonly',
        exports: 'writable', structuredClone: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-undef': 'error',
      eqeqeq: ['warn', 'smart'],
      'no-var': 'error',
      'prefer-const': 'warn'
    }
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        window: 'readonly', document: 'readonly', location: 'readonly', history: 'readonly',
        navigator: 'readonly', fetch: 'readonly', console: 'readonly', localStorage: 'readonly',
        sessionStorage: 'readonly', FormData: 'readonly', URLSearchParams: 'readonly', URL: 'readonly',
        setTimeout: 'readonly', setInterval: 'readonly', clearTimeout: 'readonly', clearInterval: 'readonly',
        Image: 'readonly', File: 'readonly', Blob: 'readonly', createImageBitmap: 'readonly',
        caches: 'readonly', self: 'readonly', Notification: 'readonly', alert: 'readonly',
        IntersectionObserver: 'readonly', requestAnimationFrame: 'readonly', CustomEvent: 'readonly',
        Event: 'readonly', matchMedia: 'readonly', getComputedStyle: 'readonly', Response: 'readonly'
      }
    },
    rules: { 'no-undef': 'off', 'no-var': 'off', 'prefer-const': 'off' }
  },
  {
    files: ['test/**/*.js'],
    languageOptions: { globals: { require: 'readonly', module: 'writable', process: 'readonly', __dirname: 'readonly', console: 'readonly', Buffer: 'readonly' } }
  }
];
