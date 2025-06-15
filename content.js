// Check if we're on Cambridge Dictionary website
const isCambridgeDictionary = window.location.hostname.includes('dictionary.cambridge.org');

// Only add event listeners if we're not on Cambridge Dictionary
if (!isCambridgeDictionary) {
  // Listen for mouseup (text selection)
  document.addEventListener('mouseup', async (event) => {
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
    chrome.runtime.sendMessage({type: 'FETCH_IPA', word: text}, (response) => {
      if (response && response.ipa) {
        showIPACard(text, response.ipa, x, y);
      } else {
        showIPACard(text, 'IPA not found', x, y);
      }
    });
  });

  // Remove card on click elsewhere
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.ipa-card-floating')) {
      document.querySelectorAll('.ipa-card-floating').forEach(el => el.remove());
    }
  });
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
