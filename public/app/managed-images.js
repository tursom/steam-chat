export function createManagedImageController() {
  const managedImageRequestMap = new WeakMap();
  let nextManagedImageToken = 1;

  function createManagedImageHost(hostClassName, imageClassName) {
    const host = document.createElement('div');
    host.className = 'image-loading-host';
    if (hostClassName) {
      hostClassName.split(/\s+/).filter(Boolean).forEach((className) => host.classList.add(className));
    }

    const img = document.createElement('img');
    img.dataset.managedImage = 'true';
    img.classList.add('image-loading-target');
    if (imageClassName) {
      imageClassName.split(/\s+/).filter(Boolean).forEach((className) => img.classList.add(className));
    }

    host.appendChild(img);
    return { host, img };
  }

  function ensureManagedImageUi(host) {
    if (host.__managedImageUi) {
      return host.__managedImageUi;
    }

    const overlay = document.createElement('div');
    overlay.className = 'image-loading-overlay';

    const label = document.createElement('div');
    label.className = 'image-loading-label';
    label.textContent = '正在加载中';

    const progress = document.createElement('div');
    progress.className = 'image-loading-progress';

    const bar = document.createElement('div');
    bar.className = 'image-loading-progress-bar';

    progress.appendChild(bar);
    overlay.appendChild(label);
    overlay.appendChild(progress);
    host.appendChild(overlay);

    host.__managedImageUi = { overlay, label, progress, bar };
    return host.__managedImageUi;
  }

  function setManagedImageState(host, state, labelText, progressValue, indeterminate) {
    const ui = ensureManagedImageUi(host);
    const nextState = state || 'idle';

    host.classList.toggle('is-loading', nextState === 'loading');
    host.classList.toggle('is-loaded', nextState === 'loaded');
    host.classList.toggle('is-error', nextState === 'error');
    host.classList.toggle('is-indeterminate', Boolean(indeterminate));

    if (labelText) {
      ui.label.textContent = labelText;
    } else if (nextState === 'error') {
      ui.label.textContent = '图片加载失败';
    } else if (nextState === 'loaded') {
      ui.label.textContent = '';
    } else {
      ui.label.textContent = '正在加载中';
    }

    const width = Number.isFinite(progressValue)
      ? Math.max(0, Math.min(100, progressValue))
      : 0;
    ui.bar.style.width = width + '%';
  }

  function abortManagedImageRequest(img) {
    const request = managedImageRequestMap.get(img);
    if (!request) {
      return;
    }

    managedImageRequestMap.delete(img);

    try {
      request.abort();
    } catch {
      // ignore
    }
  }

  function revokeManagedImageObjectUrl(img) {
    const objectUrl = img && img.dataset ? img.dataset.objectUrl : '';
    if (!objectUrl) {
      return;
    }

    try {
      URL.revokeObjectURL(objectUrl);
    } catch {
      // ignore
    }

    delete img.dataset.objectUrl;
  }

  function resetManagedImage(host, img) {
    abortManagedImageRequest(img);
    revokeManagedImageObjectUrl(img);
    delete img.dataset.managedImageLoadToken;
    img.removeAttribute('src');

    if (host) {
      setManagedImageState(host, 'idle', '', 0, false);
    }
  }

  function cleanupManagedImages(root) {
    if (!root || typeof root.querySelectorAll !== 'function') {
      return;
    }

    root.querySelectorAll('img[data-managed-image="true"]').forEach((img) => {
      resetManagedImage(img.closest('.image-loading-host'), img);
    });
  }

  function loadManagedImage(host, img, src, options) {
    const settings = options || {};
    const loadingText = settings.loadingText || '正在加载中';
    const errorText = settings.errorText || '图片加载失败';
    const normalizedSrc = String(src || '').trim();

    if (!host || !img) {
      return;
    }

    host.classList.add('image-loading-host');
    img.dataset.managedImage = 'true';
    img.classList.add('image-loading-target');

    resetManagedImage(host, img);

    if (!normalizedSrc) {
      setManagedImageState(host, 'error', errorText, 100, false);
      if (typeof settings.onError === 'function') {
        settings.onError();
      }
      return;
    }

    const token = String(nextManagedImageToken++);
    img.dataset.managedImageLoadToken = token;
    setManagedImageState(host, 'loading', loadingText, 8, true);

    const request = new XMLHttpRequest();
    managedImageRequestMap.set(img, request);
    request.open('GET', normalizedSrc, true);
    request.responseType = 'blob';

    request.onprogress = (event) => {
      if (img.dataset.managedImageLoadToken !== token) {
        return;
      }

      if (event.lengthComputable && event.total > 0) {
        const percent = Math.max(1, Math.min(99, Math.round((event.loaded / event.total) * 100)));
        setManagedImageState(host, 'loading', loadingText + ' ' + percent + '%', percent, false);
      } else {
        setManagedImageState(host, 'loading', loadingText, 32, true);
      }
    };

    request.onerror = () => {
      if (img.dataset.managedImageLoadToken !== token) {
        return;
      }
      managedImageRequestMap.delete(img);
      setManagedImageState(host, 'error', errorText, 100, false);
      if (typeof settings.onError === 'function') {
        settings.onError();
      }
    };

    request.onabort = () => {
      if (img.dataset.managedImageLoadToken !== token) {
        return;
      }
      managedImageRequestMap.delete(img);
    };

    request.onload = () => {
      if (img.dataset.managedImageLoadToken !== token) {
        return;
      }

      managedImageRequestMap.delete(img);

      if (request.status < 200 || request.status >= 300 || !(request.response instanceof Blob)) {
        setManagedImageState(host, 'error', errorText, 100, false);
        if (typeof settings.onError === 'function') {
          settings.onError();
        }
        return;
      }

      const objectUrl = URL.createObjectURL(request.response);
      img.dataset.objectUrl = objectUrl;

      img.addEventListener('load', () => {
        if (img.dataset.managedImageLoadToken !== token) {
          return;
        }
        setManagedImageState(host, 'loaded', '', 100, false);
        if (typeof settings.onLoad === 'function') {
          settings.onLoad();
        }
      }, { once: true });

      img.addEventListener('error', () => {
        if (img.dataset.managedImageLoadToken !== token) {
          return;
        }
        revokeManagedImageObjectUrl(img);
        setManagedImageState(host, 'error', errorText, 100, false);
        if (typeof settings.onError === 'function') {
          settings.onError();
        }
      }, { once: true });

      setManagedImageState(host, 'loading', '即将显示', 100, false);
      img.src = objectUrl;
    };

    request.send();
  }

  return {
    createManagedImageHost,
    cleanupManagedImages,
    loadManagedImage,
    resetManagedImage,
  };
}
