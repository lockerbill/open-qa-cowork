/**
 * Page-context capture (spec §9.5). Runs in the page's main world so it can
 * observe console errors and failed fetch/XHR. It posts only safe metadata
 * (no request/response bodies, path only) to the content script via
 * window.postMessage; the content script applies final redaction.
 */
(function () {
  'use strict';
  if (window.__qaCopilotInjected) return;
  window.__qaCopilotInjected = true;

  var SRC = 'qa-copilot-page';
  function post(payload) {
    try {
      window.postMessage(Object.assign({ __qaCopilot: SRC }, payload), '*');
    } catch (_) {
      /* ignore */
    }
  }

  function pathOf(url) {
    try {
      return new URL(url, location.href).pathname;
    } catch (_) {
      return String(url).split('?')[0];
    }
  }

  // --- console errors/warnings ---
  ['error', 'warn'].forEach(function (level) {
    var orig = console[level];
    console[level] = function () {
      try {
        var msg = Array.prototype.map
          .call(arguments, function (a) {
            return typeof a === 'string' ? a : safeStringify(a);
          })
          .join(' ');
        post({ kind: 'console', level: level === 'warn' ? 'warning' : 'error', message: msg });
      } catch (_) {
        /* ignore */
      }
      return orig.apply(console, arguments);
    };
  });

  window.addEventListener('error', function (e) {
    post({ kind: 'console', level: 'error', message: String(e.message || 'Uncaught error') });
  });
  window.addEventListener('unhandledrejection', function (e) {
    post({ kind: 'console', level: 'error', message: 'Unhandled rejection: ' + safeStringify(e.reason) });
  });

  function safeStringify(v) {
    if (v instanceof Error) return v.message;
    try {
      return typeof v === 'object' ? JSON.stringify(v).slice(0, 300) : String(v);
    } catch (_) {
      return String(v);
    }
  }

  // --- fetch failures ---
  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      var start = performance.now();
      var method = (init && init.method) || (input && input.method) || 'GET';
      var url = typeof input === 'string' ? input : input && input.url;
      return origFetch.apply(this, arguments).then(
        function (res) {
          if (!res.ok) {
            post({
              kind: 'network',
              method: method,
              urlPath: pathOf(url),
              status: res.status,
              reason: res.statusText,
              durationMs: Math.round(performance.now() - start),
            });
          }
          return res;
        },
        function (err) {
          post({
            kind: 'network',
            method: method,
            urlPath: pathOf(url),
            status: 0,
            reason: (err && err.message) || 'Network error',
            durationMs: Math.round(performance.now() - start),
          });
          throw err;
        },
      );
    };
  }

  // --- SPA route changes (spec §9.3) — must run in the page's main world ---
  function postRoute() {
    post({ kind: 'route', url: location.href, title: document.title });
  }
  var origPush = history.pushState;
  var origReplace = history.replaceState;
  history.pushState = function () {
    var r = origPush.apply(this, arguments);
    setTimeout(postRoute, 0);
    return r;
  };
  history.replaceState = function () {
    var r = origReplace.apply(this, arguments);
    setTimeout(postRoute, 0);
    return r;
  };
  window.addEventListener('popstate', postRoute);
  window.addEventListener('hashchange', postRoute);

  // --- XHR failures ---
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__qa = { method: method, url: url, start: 0 };
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var self = this;
    if (self.__qa) {
      self.__qa.start = performance.now();
      self.addEventListener('loadend', function () {
        if (self.status === 0 || self.status >= 400) {
          post({
            kind: 'network',
            method: self.__qa.method,
            urlPath: pathOf(self.__qa.url),
            status: self.status,
            reason: self.statusText || 'Request failed',
            durationMs: Math.round(performance.now() - self.__qa.start),
          });
        }
      });
    }
    return origSend.apply(this, arguments);
  };
})();
