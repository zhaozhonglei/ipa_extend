// Check if we're on Cambridge Dictionary website
const isCambridgeDictionary = window.location.hostname.includes('dictionary.cambridge.org');

// Only add event listeners if we're not on Cambridge Dictionary
if (!isCambridgeDictionary) {
  // Listen for mouseup (text selection)
  document.addEventListener('mouseup', async (event) => {
    // 点击卡片内部（如喇叭按钮）时不重新查词
    if (event.target.closest && event.target.closest('.ipa-card-floating')) return;
    const selection = window.getSelection();
    const text = selection.toString().trim();
    if (!text || text.split(/\s+/).length > 1) return;

    // Remove any existing IPA card
    document.querySelectorAll('.ipa-card-floating').forEach(el => el.remove());

    // Get selection position
    const range = selection.rangeCount ? selection.getRangeAt(0) : null;
    let x = event.pageX, y = event.pageY;
    if (range) {
      const rect = range.getBoundingClientRect();
      x = rect.left + window.scrollX;
      y = rect.bottom + window.scrollY;
    }

    // Request IPA from background
    console.log('[IPA EXT] lookup:', text);
    try {
      chrome.runtime.sendMessage({type: 'FETCH_IPA', word: text}, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          console.error('[IPA EXT] sendMessage error:', lastError.message);
          showErrorCard(`后台无响应: ${lastError.message}`, x, y);
        } else if (response && response.ipa) {
          try {
            showIPACard(text, response.ipa, x, y);
          } catch (err) {
            console.error('[IPA EXT] render error:', err);
            showErrorCard(`卡片渲染失败: ${err.message}`, x, y);
          }
        } else if (response && response.challenge) {
          showChallengeCard(x, y);
        } else {
          showErrorCard((response && response.error) || 'IPA not found', x, y);
        }
      });
    } catch (err) {
      // 扩展重新加载后，旧页面里的脚本会抛 "Extension context invalidated"
      console.error('[IPA EXT] sendMessage threw:', err);
      showErrorCard(`扩展已失效，请刷新页面: ${err.message}`, x, y);
    }
  });

  // Remove card on click elsewhere
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.ipa-card-floating')) {
      document.querySelectorAll('.ipa-card-floating').forEach(el => el.remove());
    }
  });
}

function showErrorCard(msg, x, y) {
  const card = document.createElement('div');
  card.className = 'ipa-card-floating';
  card.textContent = msg;
  card.style.left = `${x}px`;
  card.style.top = `${y}px`;
  document.body.appendChild(card);
}

function showChallengeCard(x, y) {
  const card = document.createElement('div');
  card.className = 'ipa-card-floating';
  card.append('剑桥词典需要人机验证，已为你切换到剑桥标签页。');
  const link = document.createElement('a');
  link.href = 'https://dictionary.cambridge.org/';
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = '点此打开剑桥词典完成验证';
  card.append(document.createElement('br'), link, document.createElement('br'), '在剑桥标签页完成验证后，保持该标签页打开，回到本页重新选词。');
  card.style.left = `${x}px`;
  card.style.top = `${y}px`;
  document.body.appendChild(card);
}

function showIPACard(word, ipa, x, y) {
  const card = document.createElement('div');
  card.className = 'ipa-card-floating';
  card.innerHTML = `${ipa}`;
  card.style.left = `${x}px`;
  card.style.top = `${y}px`;
  document.body.appendChild(card);

  // 补全 audio 的 src 路径（只补全相对路径）
  card.querySelectorAll('audio source').forEach(source => {
    if (source.getAttribute('src') && source.getAttribute('src').startsWith('/')) {
      source.setAttribute('src', 'https://dictionary.cambridge.org' + source.getAttribute('src'));
    }
  });

  // 让所有小喇叭按钮可点击发声（通过 background 代理 mp3）
  card.querySelectorAll('.i-volume-up').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      // 找到同级最近的 audio > source[type=audio/mpeg]
      const source = btn.closest('.daud')?.querySelector('audio source[type="audio/mpeg"]');
      if (source) {
        let mp3Url = source.getAttribute('src');
        if (mp3Url.startsWith('/')) {
          mp3Url = 'https://dictionary.cambridge.org' + mp3Url;
        }
        playMp3ViaProxy(mp3Url);
      }
    });
  });
}

function playMp3ViaProxy(mp3Url) {
  chrome.runtime.sendMessage({ type: 'FETCH_MP3_PROXY', url: mp3Url }, response => {
    if (response && response.base64) {
      const blob = base64ToBlob(response.base64, 'audio/mpeg');
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.play();
    } else {
      alert('音频加载失败');
    }
  });
}

function base64ToBlob(base64, mime) {
  const byteChars = atob(base64);
  const byteNumbers = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) {
    byteNumbers[i] = byteChars.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: mime });
}
