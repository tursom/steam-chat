export function createLightboxController({
  buildCachedImageUrl,
  imageLightbox,
  imageLightboxViewport,
  imageLightboxImage,
  imageLightboxCaption,
  closeImageLightboxButton,
  imageZoomOutButton,
  imageZoomResetButton,
  imageZoomInButton,
  loadManagedImage,
  resetManagedImage,
}) {
  let lastFocusedElementBeforeLightbox = null;
  const imageLightboxState = {
    scale: 1,
    minScale: 1,
    maxScale: 6,
    offsetX: 0,
    offsetY: 0,
    dragging: false,
    dragPointerId: null,
    dragStartX: 0,
    dragStartY: 0,
    dragOriginX: 0,
    dragOriginY: 0,
    activePointers: new Map(),
    pinching: false,
    pinchStartDistance: 0,
    pinchStartScale: 1,
    pinchContentX: 0,
    pinchContentY: 0,
    rafPending: false,
    cachedBaseSize: null,
    cachedViewportRect: null,
  };

  function resolveDisplayImageUrl(url) {
    const value = String(url || '').trim();
    if (!value) {
      return '';
    }

    try {
      const parsed = new URL(value, location.origin);
      if (parsed.origin === location.origin) {
        return parsed.toString();
      }
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return buildCachedImageUrl(parsed.toString());
      }
      return parsed.toString();
    } catch {
      return value;
    }
  }

  function computeImageLightboxBaseSize() {
    const viewportWidth = imageLightboxViewport.clientWidth || 1;
    const viewportHeight = imageLightboxViewport.clientHeight || 1;
    const naturalWidth = imageLightboxImage.naturalWidth || viewportWidth;
    const naturalHeight = imageLightboxImage.naturalHeight || viewportHeight;
    const fitScale = Math.min(viewportWidth / naturalWidth, viewportHeight / naturalHeight, 1);

    return {
      width: naturalWidth * fitScale,
      height: naturalHeight * fitScale,
      viewportWidth,
      viewportHeight,
    };
  }

  function refreshImageLightboxBaseSize() {
    imageLightboxState.cachedBaseSize = computeImageLightboxBaseSize();
    imageLightboxState.cachedViewportRect = imageLightboxViewport.getBoundingClientRect();
  }

  function getImageLightboxBaseSize() {
    return imageLightboxState.cachedBaseSize || computeImageLightboxBaseSize();
  }

  function clampImageLightboxOffset() {
    if (imageLightboxState.scale <= 1) {
      imageLightboxState.offsetX = 0;
      imageLightboxState.offsetY = 0;
      return;
    }

    const { width, height, viewportWidth, viewportHeight } = getImageLightboxBaseSize();
    const scaledWidth = width * imageLightboxState.scale;
    const scaledHeight = height * imageLightboxState.scale;
    const limitX = Math.max(0, (scaledWidth - viewportWidth) / 2);
    const limitY = Math.max(0, (scaledHeight - viewportHeight) / 2);

    imageLightboxState.offsetX = Math.min(limitX, Math.max(-limitX, imageLightboxState.offsetX));
    imageLightboxState.offsetY = Math.min(limitY, Math.max(-limitY, imageLightboxState.offsetY));
  }

  function getViewportRelativePoint(clientX, clientY) {
    const rect = imageLightboxState.cachedViewportRect || imageLightboxViewport.getBoundingClientRect();
    return {
      x: clientX - rect.left - (rect.width / 2),
      y: clientY - rect.top - (rect.height / 2),
    };
  }

  function getTouchPointerList() {
    return [...imageLightboxState.activePointers.values()].filter((pointer) => pointer.pointerType === 'touch');
  }

  function getTouchPointerMetrics(pointers) {
    if (!pointers || pointers.length < 2) {
      return null;
    }

    const [first, second] = pointers;
    const deltaX = second.clientX - first.clientX;
    const deltaY = second.clientY - first.clientY;

    return {
      distance: Math.hypot(deltaX, deltaY),
      centerX: (first.clientX + second.clientX) / 2,
      centerY: (first.clientY + second.clientY) / 2,
    };
  }

  function applyImageLightboxTransform() {
    imageLightboxState.rafPending = false;
    clampImageLightboxOffset();
    imageLightboxImage.style.transform = 'translate3d(' + imageLightboxState.offsetX + 'px, ' + imageLightboxState.offsetY + 'px, 0) scale(' + imageLightboxState.scale + ')';
  }

  function updateImageLightboxTransform() {
    const isActive = imageLightboxState.dragging || imageLightboxState.pinching;
    imageLightboxImage.classList.toggle('is-dragging', isActive);
    imageLightboxImage.style.cursor = imageLightboxState.scale > 1
      ? (isActive ? 'grabbing' : 'grab')
      : 'zoom-in';
    imageZoomResetButton.textContent = Math.round(imageLightboxState.scale * 100) + '%';
    if (!imageLightboxState.rafPending) {
      imageLightboxState.rafPending = true;
      requestAnimationFrame(applyImageLightboxTransform);
    }
  }

  function scheduleTransformOnly() {
    if (!imageLightboxState.rafPending) {
      imageLightboxState.rafPending = true;
      requestAnimationFrame(applyImageLightboxTransform);
    }
  }

  function beginImageLightboxDrag(pointerId, clientX, clientY) {
    imageLightboxState.dragging = true;
    imageLightboxState.dragPointerId = pointerId;
    imageLightboxState.dragStartX = clientX;
    imageLightboxState.dragStartY = clientY;
    imageLightboxState.dragOriginX = imageLightboxState.offsetX;
    imageLightboxState.dragOriginY = imageLightboxState.offsetY;
    updateImageLightboxTransform();
  }

  function resetImageLightboxTransform() {
    imageLightboxState.scale = 1;
    imageLightboxState.offsetX = 0;
    imageLightboxState.offsetY = 0;
    imageLightboxState.dragging = false;
    imageLightboxState.dragPointerId = null;
    imageLightboxState.activePointers.clear();
    imageLightboxState.pinching = false;
    imageLightboxState.pinchStartDistance = 0;
    imageLightboxState.pinchStartScale = 1;
    imageLightboxState.pinchContentX = 0;
    imageLightboxState.pinchContentY = 0;
    updateImageLightboxTransform();
  }

  function setImageLightboxScale(nextScale, clientX, clientY) {
    const clampedScale = Math.min(imageLightboxState.maxScale, Math.max(imageLightboxState.minScale, nextScale));
    const previousScale = imageLightboxState.scale;

    if (Math.abs(clampedScale - previousScale) < 0.001) {
      return;
    }

    const anchorPoint = (typeof clientX === 'number' && typeof clientY === 'number')
      ? getViewportRelativePoint(clientX, clientY)
      : { x: 0, y: 0 };

    imageLightboxState.offsetX = anchorPoint.x - (((anchorPoint.x - imageLightboxState.offsetX) / previousScale) * clampedScale);
    imageLightboxState.offsetY = anchorPoint.y - (((anchorPoint.y - imageLightboxState.offsetY) / previousScale) * clampedScale);
    imageLightboxState.scale = clampedScale;
    updateImageLightboxTransform();
  }

  function beginImageLightboxPinch() {
    const metrics = getTouchPointerMetrics(getTouchPointerList());
    if (!metrics) {
      return;
    }

    const center = getViewportRelativePoint(metrics.centerX, metrics.centerY);
    imageLightboxState.pinching = true;
    imageLightboxState.dragging = false;
    imageLightboxState.dragPointerId = null;
    imageLightboxState.pinchStartDistance = Math.max(metrics.distance, 1);
    imageLightboxState.pinchStartScale = imageLightboxState.scale;
    imageLightboxState.pinchContentX = (center.x - imageLightboxState.offsetX) / imageLightboxState.scale;
    imageLightboxState.pinchContentY = (center.y - imageLightboxState.offsetY) / imageLightboxState.scale;
    updateImageLightboxTransform();
  }

  function updateImageLightboxPinch() {
    const metrics = getTouchPointerMetrics(getTouchPointerList());
    if (!metrics || !imageLightboxState.pinching) {
      return;
    }

    const center = getViewportRelativePoint(metrics.centerX, metrics.centerY);
    const nextScale = Math.min(
      imageLightboxState.maxScale,
      Math.max(
        imageLightboxState.minScale,
        imageLightboxState.pinchStartScale * (metrics.distance / Math.max(imageLightboxState.pinchStartDistance, 1)),
      ),
    );

    imageLightboxState.scale = nextScale;
    imageLightboxState.offsetX = center.x - (imageLightboxState.pinchContentX * nextScale);
    imageLightboxState.offsetY = center.y - (imageLightboxState.pinchContentY * nextScale);
    scheduleTransformOnly();
  }

  function endImageLightboxPinch() {
    if (!imageLightboxState.pinching) {
      return;
    }

    imageLightboxState.pinching = false;
    imageLightboxState.pinchStartDistance = 0;
    imageLightboxState.pinchStartScale = imageLightboxState.scale;
    const remainingTouch = getTouchPointerList()[0];
    if (remainingTouch && imageLightboxState.scale > 1) {
      beginImageLightboxDrag(remainingTouch.pointerId, remainingTouch.clientX, remainingTouch.clientY);
      return;
    }
    updateImageLightboxTransform();
  }

  function openImageLightbox(url, caption) {
    const displayUrl = resolveDisplayImageUrl(url);
    if (!displayUrl) {
      return;
    }

    lastFocusedElementBeforeLightbox = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    resetImageLightboxTransform();
    loadManagedImage(imageLightboxViewport, imageLightboxImage, displayUrl, {
      loadingText: '大图加载中',
      errorText: '大图加载失败',
      onLoad() {
        refreshImageLightboxBaseSize();
        updateImageLightboxTransform();
      },
    });
    imageLightboxCaption.textContent = caption || url || '';
    imageLightbox.classList.add('open');
    imageLightbox.setAttribute('aria-hidden', 'false');
    closeImageLightboxButton.focus();
  }

  function closeImageLightbox() {
    if (!imageLightbox.classList.contains('open')) {
      return;
    }

    imageLightbox.classList.remove('open');
    imageLightbox.setAttribute('aria-hidden', 'true');
    resetManagedImage(imageLightboxViewport, imageLightboxImage);
    imageLightboxCaption.textContent = '';
    imageLightboxState.cachedBaseSize = null;
    imageLightboxState.cachedViewportRect = null;
    resetImageLightboxTransform();
    if (lastFocusedElementBeforeLightbox) {
      lastFocusedElementBeforeLightbox.focus();
      lastFocusedElementBeforeLightbox = null;
    }
  }

  function makeImageZoomable(element, url, caption) {
    element.classList.add('zoomable-image');
    element.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openImageLightbox(url, caption || element.getAttribute('alt') || '');
    });
  }

  function stopImageLightboxDrag(event) {
    const hadPointer = imageLightboxState.activePointers.delete(event.pointerId);

    if (imageLightboxState.pinching && getTouchPointerList().length < 2) {
      endImageLightboxPinch();
    }

    if (!imageLightboxState.dragging || imageLightboxState.dragPointerId !== event.pointerId) {
      if (hadPointer && imageLightboxViewport.hasPointerCapture(event.pointerId)) {
        imageLightboxViewport.releasePointerCapture(event.pointerId);
      }
      return;
    }

    imageLightboxState.dragging = false;
    imageLightboxState.dragPointerId = null;
    if (imageLightboxViewport.hasPointerCapture(event.pointerId)) {
      imageLightboxViewport.releasePointerCapture(event.pointerId);
    }
    updateImageLightboxTransform();
  }

  function bindEvents() {
    imageLightbox.addEventListener('click', (event) => {
      if (event.target === imageLightbox) {
        closeImageLightbox();
      }
    });

    imageLightboxViewport.addEventListener('wheel', (event) => {
      if (!imageLightbox.classList.contains('open')) {
        return;
      }

      event.preventDefault();
      const factor = Math.exp(-event.deltaY * 0.0025);
      setImageLightboxScale(imageLightboxState.scale * factor, event.clientX, event.clientY);
    }, { passive: false });

    imageLightboxViewport.addEventListener('pointerdown', (event) => {
      if (!imageLightbox.classList.contains('open')) {
        return;
      }

      imageLightboxViewport.setPointerCapture(event.pointerId);
      imageLightboxState.activePointers.set(event.pointerId, {
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        clientX: event.clientX,
        clientY: event.clientY,
      });

      if (event.pointerType === 'touch') {
        event.preventDefault();
        if (getTouchPointerList().length >= 2) {
          beginImageLightboxPinch();
          return;
        }
      }

      if (event.button !== 0 || imageLightboxState.scale <= 1) {
        return;
      }

      event.preventDefault();
      beginImageLightboxDrag(event.pointerId, event.clientX, event.clientY);
    });

    imageLightboxViewport.addEventListener('pointermove', (event) => {
      if (imageLightboxState.activePointers.has(event.pointerId)) {
        imageLightboxState.activePointers.set(event.pointerId, {
          pointerId: event.pointerId,
          pointerType: event.pointerType,
          clientX: event.clientX,
          clientY: event.clientY,
        });
      }

      if (imageLightboxState.pinching) {
        event.preventDefault();
        updateImageLightboxPinch();
        return;
      }

      if (!imageLightboxState.dragging || imageLightboxState.dragPointerId !== event.pointerId) {
        return;
      }

      imageLightboxState.offsetX = imageLightboxState.dragOriginX + (event.clientX - imageLightboxState.dragStartX);
      imageLightboxState.offsetY = imageLightboxState.dragOriginY + (event.clientY - imageLightboxState.dragStartY);
      scheduleTransformOnly();
    });

    imageLightboxViewport.addEventListener('pointerup', stopImageLightboxDrag);
    imageLightboxViewport.addEventListener('pointercancel', stopImageLightboxDrag);
    imageLightboxViewport.addEventListener('dblclick', (event) => {
      event.preventDefault();
      if (imageLightboxState.scale > 1) {
        resetImageLightboxTransform();
        return;
      }
      setImageLightboxScale(2, event.clientX, event.clientY);
    });

    imageLightboxImage.addEventListener('load', () => {
      refreshImageLightboxBaseSize();
      resetImageLightboxTransform();
    });

    imageZoomOutButton.addEventListener('click', () => {
      setImageLightboxScale(imageLightboxState.scale / 1.2);
    });

    imageZoomResetButton.addEventListener('click', resetImageLightboxTransform);

    imageZoomInButton.addEventListener('click', () => {
      setImageLightboxScale(imageLightboxState.scale * 1.2);
    });

    closeImageLightboxButton.addEventListener('click', closeImageLightbox);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && imageLightbox.classList.contains('open')) {
        closeImageLightbox();
        return;
      }

      if (!imageLightbox.classList.contains('open')) {
        return;
      }

      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        setImageLightboxScale(imageLightboxState.scale * 1.2);
      } else if (event.key === '-') {
        event.preventDefault();
        setImageLightboxScale(imageLightboxState.scale / 1.2);
      } else if (event.key === '0') {
        event.preventDefault();
        resetImageLightboxTransform();
      }
    });
  }

  function handleWindowResize() {
    if (imageLightbox.classList.contains('open')) {
      refreshImageLightboxBaseSize();
    }
  }

  bindEvents();

  return {
    closeImageLightbox,
    handleWindowResize,
    makeImageZoomable,
    openImageLightbox,
  };
}
