const CACHE_NAME = "tv-distance-alarm-v2";

const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json"
];


self.addEventListener(
  "install",
  event => {

    event.waitUntil(
      caches
        .open(CACHE_NAME)
        .then(cache =>
          cache.addAll(APP_SHELL)
        )
    );

    self.skipWaiting();
  }
);


self.addEventListener(
  "activate",
  event => {

    event.waitUntil(
      self.clients.claim()
    );
  }
);


self.addEventListener(
  "fetch",
  event => {

    if (
      event.request.method !== "GET"
    ) {
      return;
    }


    const url =
      new URL(event.request.url);


    /*
     * Cache our own application files.
     *
     * MediaPipe remains CDN-backed for now.
     */

    if (
      url.origin === location.origin
    ) {

      event.respondWith(
        caches
          .match(event.request)
          .then(
            cached =>
              cached ||
              fetch(event.request)
          )
      );
    }
  }
);
