(function () {
  if (window.idb && typeof window.idb.openDB === "function") return;

  function requestPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function transactionPromise(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  function wrapStore(store) {
    return {
      put(value, key) {
        return requestPromise(key === undefined ? store.put(value) : store.put(value, key));
      },
      add(value, key) {
        return requestPromise(key === undefined ? store.add(value) : store.add(value, key));
      },
      get(key) {
        return requestPromise(store.get(key));
      },
      getAll() {
        return requestPromise(store.getAll());
      },
      delete(key) {
        return requestPromise(store.delete(key));
      },
      clear() {
        return requestPromise(store.clear());
      },
      createIndex(name, keyPath, options) {
        return store.createIndex(name, keyPath, options);
      }
    };
  }

  function wrapTransaction(tx, defaultStoreName) {
    return {
      done: transactionPromise(tx),
      objectStore(name) {
        return wrapStore(tx.objectStore(name));
      },
      get store() {
        return wrapStore(tx.objectStore(defaultStoreName));
      }
    };
  }

  function wrapDb(db) {
    return {
      objectStoreNames: db.objectStoreNames,
      createObjectStore(name, options) {
        return db.createObjectStore(name, options);
      },
      transaction(storeNames, mode) {
        const tx = db.transaction(storeNames, mode);
        const defaultStoreName = Array.isArray(storeNames) ? storeNames[0] : storeNames;
        return wrapTransaction(tx, defaultStoreName);
      },
      get(storeName, key) {
        return requestPromise(db.transaction(storeName, "readonly").objectStore(storeName).get(key));
      },
      getAll(storeName) {
        return requestPromise(db.transaction(storeName, "readonly").objectStore(storeName).getAll());
      },
      put(storeName, value, key) {
        return requestPromise(db.transaction(storeName, "readwrite").objectStore(storeName).put(value, key));
      },
      delete(storeName, key) {
        return requestPromise(db.transaction(storeName, "readwrite").objectStore(storeName).delete(key));
      },
      count(storeName) {
        return requestPromise(db.transaction(storeName, "readonly").objectStore(storeName).count());
      }
    };
  }

  function openDB(name, version, options = {}) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name, version);
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = (event) => {
        if (typeof options.upgrade === "function") {
          options.upgrade(request.result, event.oldVersion, event.newVersion, request.transaction);
        }
      };
      request.onsuccess = () => resolve(wrapDb(request.result));
    });
  }

  window.idb = { openDB };
})();
