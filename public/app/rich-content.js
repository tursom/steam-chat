export function createRichContentRenderer({
  buildSteamEmoticonUrl,
  buildCachedImageUrl,
  extractImageUrls,
  parseBbCodeAttributes,
  createManagedImageHost,
  makeImageZoomable,
  loadManagedImage,
}) {
  function appendEmoticonImage(fragment, name) {
    const rawUrl = buildSteamEmoticonUrl(name, true);
    if (!rawUrl) {
      fragment.appendChild(document.createTextNode(':' + name + ':'));
      return;
    }

    const link = document.createElement('a');
    link.href = rawUrl;
    link.target = '_blank';
    link.rel = 'noreferrer';

    const img = document.createElement('img');
    img.src = buildCachedImageUrl(rawUrl);
    img.alt = ':' + name + ':';
    img.title = ':' + name + ':';
    img.className = 'inline-emoticon';
    link.appendChild(img);
    fragment.appendChild(link);
  }

  function appendInlineImage(fragment, url, altText, options = {}) {
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.className = 'inline-image-link';

    const { host, img } = createManagedImageHost('image-loading-host--inline', 'image-preview');
    img.alt = altText || '[图片]';
    img.title = altText || url;
    makeImageZoomable(host, url, altText || url);
    loadManagedImage(host, img, buildCachedImageUrl(url), {
      onLoad: options.onAsyncLayoutChange,
      onError: options.onAsyncLayoutChange,
    });

    link.appendChild(host);
    fragment.appendChild(link);
  }

  function appendOpenGraphCard(fragment, embed, options = {}) {
    const wrapper = document.createElement('a');
    wrapper.href = embed.url;
    wrapper.target = '_blank';
    wrapper.rel = 'noreferrer';
    wrapper.className = 'og-card';

    if (embed.img) {
      const { host, img } = createManagedImageHost('image-loading-host--card', 'image-preview');
      img.alt = embed.title || embed.url;
      makeImageZoomable(host, embed.img, embed.title || embed.url);
      loadManagedImage(host, img, buildCachedImageUrl(embed.img), {
        onLoad: options.onAsyncLayoutChange,
        onError: options.onAsyncLayoutChange,
      });
      wrapper.appendChild(host);
    }

    const title = document.createElement('div');
    title.className = 'og-card-title';
    title.textContent = embed.title || embed.url;
    wrapper.appendChild(title);

    const url = document.createElement('div');
    url.className = 'og-card-url';
    url.textContent = embed.url;
    wrapper.appendChild(url);

    fragment.appendChild(wrapper);
  }

  function createRichMessageContent(text, options = {}) {
    const fragment = document.createDocumentFragment();
    const content = String(text || '').replace(/\[img\s+src=(https?:\/\/[^\s\]]+)[^\]]*\][\s\S]*?\[\/img\]/gi, '[img]$1[/img]');
    const tokenRegex = /(\[emoticon\s+name="([^"]+)"\](?:\[\/emoticon\])?)|(\[emoticon\]([^\[]+)\[\/emoticon\])|(:([a-z0-9_][a-z0-9_\-]*):)|(\[img\](https?:\/\/[^\s\[\]]+?)\[\/img\])|(<img\b[^>]*?\bsrc=["'](https?:\/\/[^"']+)["'][^>]*>)|(\[og\s+([^\]]+)\]([\s\S]*?)\[\/og\])|(\[url=([^\]]+)\]([\s\S]*?)\[\/url\])|(\[url\]([\s\S]*?)\[\/url\])|(https?:\/\/\S+)/gi;
    let cursor = 0;
    let match;

    while ((match = tokenRegex.exec(content)) !== null) {
      if (match.index > cursor) {
        fragment.appendChild(document.createTextNode(content.slice(cursor, match.index)));
      }

      if (match[2]) {
        appendEmoticonImage(fragment, match[2]);
      } else if (match[4]) {
        appendEmoticonImage(fragment, match[4].trim());
      } else if (match[6]) {
        appendEmoticonImage(fragment, match[6]);
      } else if (match[8]) {
        appendInlineImage(fragment, match[8], '[img]', options);
      } else if (match[10]) {
        appendInlineImage(fragment, match[10], '<img>', options);
      } else if (match[11]) {
        const attrs = parseBbCodeAttributes(match[12] || '');
        const fallbackUrl = String(match[13] || '').trim();
        const embed = {
          url: attrs.url || fallbackUrl,
          img: attrs.img || null,
          title: attrs.title || '',
        };
        if (embed.url) {
          appendOpenGraphCard(fragment, embed, options);
        }
      } else if (match[14]) {
        const href = match[15];
        const label = match[16] || href;
        const link = document.createElement('a');
        link.href = href;
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.textContent = label;
        fragment.appendChild(link);
      } else if (match[17]) {
        const href = match[18];
        const link = document.createElement('a');
        link.href = href;
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.textContent = href;
        fragment.appendChild(link);
      } else if (match[19]) {
        const rawUrl = match[19];
        if (extractImageUrls(rawUrl).length > 0) {
          appendInlineImage(fragment, rawUrl, rawUrl, options);
        } else {
          const link = document.createElement('a');
          link.href = rawUrl;
          link.target = '_blank';
          link.rel = 'noreferrer';
          link.textContent = rawUrl;
          fragment.appendChild(link);
        }
      }

      cursor = match.index + match[0].length;
    }

    if (cursor < content.length) {
      fragment.appendChild(document.createTextNode(content.slice(cursor)));
    }

    return fragment;
  }

  return {
    createRichMessageContent,
  };
}
