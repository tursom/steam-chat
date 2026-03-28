export function createMessagesController({
  messagesEl,
  cleanupManagedImages,
  parseDateString,
  sameDay,
  formatDayLabel,
  formatTimeLabel,
  getActiveConversationId,
  renderMessageBubble,
}) {
  let lastRenderedEntry = null;
  let pendingScrollFrame = 0;

  function scrollToBottom() {
    if (pendingScrollFrame) {
      cancelAnimationFrame(pendingScrollFrame);
    }

    pendingScrollFrame = requestAnimationFrame(() => {
      pendingScrollFrame = 0;
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  function clearMessages() {
    cleanupManagedImages(messagesEl);
    messagesEl.replaceChildren();
    lastRenderedEntry = null;
  }

  function insertDivider(text, className, container = messagesEl) {
    const divider = document.createElement('div');
    divider.className = className;
    divider.textContent = text;
    container.appendChild(divider);
  }

  function appendEntry(entry, previousEntry = lastRenderedEntry, options = {}) {
    if (!entry || !entry.id) {
      return;
    }

    const {
      container = messagesEl,
      autoScroll = true,
      stickToBottom = autoScroll,
    } = options;

    const activeId = getActiveConversationId();
    if (activeId && entry.id !== activeId) {
      return;
    }

    const currentDate = parseDateString(entry.date || entry.sentAt);
    const previousDate = previousEntry ? parseDateString(previousEntry.date || previousEntry.sentAt) : null;

    if (currentDate && (!previousDate || !sameDay(currentDate, previousDate))) {
      insertDivider(formatDayLabel(entry.date || entry.sentAt), 'day-divider', container);
    } else if (currentDate && previousDate && (currentDate.getTime() - previousDate.getTime()) >= 10 * 60 * 1000) {
      insertDivider(formatTimeLabel(entry.date || entry.sentAt), 'time-divider', container);
    }

    const row = document.createElement('div');
    row.className = 'message-row ' + (entry.echo ? 'self' : 'other');

    const meta = document.createElement('div');
    meta.className = 'message-meta';
    meta.textContent = (entry.name || (entry.echo ? '我' : '对方')) + ' · ' + formatTimeLabel(entry.date || entry.sentAt);

    const bubble = renderMessageBubble(entry, {
      onAsyncLayoutChange: stickToBottom
        ? () => {
          scrollToBottom();
        }
        : null,
    });

    row.appendChild(meta);
    row.appendChild(bubble);
    container.appendChild(row);
    if (autoScroll && container === messagesEl) {
      lastRenderedEntry = entry;
      scrollToBottom();
    }
  }

  function renderHistory(items) {
    clearMessages();
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = '暂无历史消息';
      messagesEl.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    let previousEntry = null;
    items.forEach((entry) => {
      appendEntry(entry, previousEntry, {
        container: fragment,
        autoScroll: false,
        stickToBottom: true,
      });
      previousEntry = entry;
    });
    messagesEl.appendChild(fragment);
    lastRenderedEntry = previousEntry;
    scrollToBottom();
  }

  return {
    appendEntry,
    clearMessages,
    renderHistory,
    scrollToBottom,
  };
}
