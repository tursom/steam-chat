export function createMessageBubbleRenderer({
  createManagedImageHost,
  makeImageZoomable,
  loadManagedImage,
  buildCachedImageUrl,
  createRichMessageContent,
  extractStickerType,
  buildSteamStickerCandidateUrls,
  extractImageUrls,
}) {
  function extractStandaloneImageUrl(message) {
    const normalizedMessage = String(message || '')
      .trim()
      .replace(/\[img\s+src=(https?:\/\/[^\s\]]+)[^\]]*\][\s\S]*?\[\/img\]/gi, '[img]$1[/img]');

    if (!normalizedMessage) {
      return '';
    }

    const imageUrls = extractImageUrls(normalizedMessage);
    if (imageUrls.length !== 1) {
      return '';
    }

    const leftoverText = normalizedMessage
      .replace(/\[img\](https?:\/\/[^\s\[\]]+?)\[\/img\]/gi, '')
      .replace(/<img\b[^>]*?\bsrc=["'](https?:\/\/[^"']+)["'][^>]*>/gi, '')
      .replace(/https?:\/\/\S+?(?:png|jpe?g|gif|webp|bmp)(?:\?\S*)?/gi, '')
      .trim();

    return leftoverText === '' ? imageUrls[0] : '';
  }

  function renderImageBubble(bubble, entry) {
    bubble.classList.add('image-bubble');

    const rawImageUrl = entry.imageUrl;
    const { host, img } = createManagedImageHost('image-loading-host--bubble');
    img.alt = 'image';
    makeImageZoomable(host, rawImageUrl, rawImageUrl);
    loadManagedImage(host, img, buildCachedImageUrl(rawImageUrl));
    bubble.appendChild(host);
  }

  function renderStickerBubble(bubble, stickerType) {
    bubble.classList.add('sticker-bubble');

    const stickerCandidates = buildSteamStickerCandidateUrls(stickerType);
    if (stickerCandidates.length) {
      const stickerImage = document.createElement('img');
      stickerImage.className = 'sticker-image';
      stickerImage.alt = stickerType;
      let stickerIndex = 0;
      stickerImage.src = location.origin + '/proxy/sticker/' + encodeURIComponent(stickerType);
      stickerImage.addEventListener('error', () => {
        stickerIndex += 1;
        if (stickerIndex < stickerCandidates.length) {
          stickerImage.src = stickerCandidates[stickerIndex];
        } else {
          stickerImage.remove();
        }
      });
      bubble.appendChild(stickerImage);
    }

    const title = document.createElement('div');
    title.className = 'sticker-title';
    title.textContent = '\u2728';

    const name = document.createElement('div');
    name.className = 'sticker-name';
    name.textContent = stickerType.replace(/^Sticker_/, '');

    const raw = document.createElement('div');
    raw.className = 'sticker-raw';
    raw.textContent = 'Sticker';

    bubble.appendChild(title);
    bubble.appendChild(name);
    bubble.appendChild(raw);
  }

  function renderTextBubble(bubble, entry) {
    bubble.appendChild(createRichMessageContent(entry.message || ''));
  }

  function renderMessageBubble(entry) {
    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    if (entry.type === 'image' || entry.imageUrl) {
      renderImageBubble(bubble, entry);
      return bubble;
    }

    const stickerType = extractStickerType(entry.message);
    if (stickerType) {
      renderStickerBubble(bubble, stickerType);
      return bubble;
    }

    // 仅包含单张图片的消息（BBCode / HTML / 纯图片链接）走大图气泡
    const standaloneImageUrl = extractStandaloneImageUrl(entry.message);
    if (standaloneImageUrl) {
      renderImageBubble(bubble, { ...entry, imageUrl: standaloneImageUrl });
      return bubble;
    }

    renderTextBubble(bubble, entry);
    return bubble;
  }

  return {
    renderImageBubble,
    renderMessageBubble,
    renderStickerBubble,
    renderTextBubble,
  };
}
