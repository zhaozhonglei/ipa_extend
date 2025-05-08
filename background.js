chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'FETCH_IPA') {
    const word = encodeURIComponent(message.word);
    const url = `https://dictionary.cambridge.org/dictionary/english-chinese-simplified/${word}`;
    console.log('[IPA EXT] Fetching URL:', url);
    fetch(url)
      .then(res => res.text())
      .then(html => {
        // Parse IPA from HTML
        const ipa = extractIPA(html);
        if (!ipa) {
          console.warn('[IPA EXT] IPA not found for', message.word);
        } else {
          console.log('[IPA EXT] IPA found:', ipa);
        }
        sendResponse({ipa});
      })
      .catch((err) => {
        console.error('[IPA EXT] Fetch error:', err);
        sendResponse({ipa: null});
      });
    return true; // Indicate async response
  }

  if (message.type === 'FETCH_MP3_PROXY' && message.url) {
    fetch(message.url)
      .then(res => res.arrayBuffer())
      .then(buffer => {
        const base64 = arrayBufferToBase64(buffer);
        sendResponse({ base64 });
      })
      .catch(err => {
        console.error('[IPA EXT] MP3 proxy fetch error:', err);
        sendResponse({ base64: null });
      });
    return true;
  }
});

function extractIPA(html) {
  try {
    // 1. 找到 <div class="di-body">，只取第一个
    const diBodyMatch = html.match(/<div class="di-body">([\s\S]*?)<div class="pos-body">/i);
    if (!diBodyMatch) {
      console.warn('[IPA EXT] <div.di-body> not found');
      return null;
    }
    const diBodyHtml = diBodyMatch[1];
    console.log('[IPA EXT] di-body extracted');
    console.log('[IPA EXT] diBodyHtml:', diBodyHtml);

    // 2. 匹配所有 <div class="pos-header dpos-h"> ... (到下一个 pos-header、pos-body 或结尾)
    const blocks = [];
    const blockRegex = /<div class="pos-header dpos-h">/g;
    let match;
    while ((match = blockRegex.exec(diBodyHtml)) !== null) {
      const start = match.index;
      // 查找下一个 pos-header 或 pos-body
      const nextPosHeader = diBodyHtml.indexOf('<div class="pos-header dpos-h">', start + 1);
      const nextPosBody = diBodyHtml.indexOf('<div class="pos-body">', start + 1);
      let end;
      if (nextPosHeader === -1 && nextPosBody === -1) {
        end = diBodyHtml.length;
      } else if (nextPosHeader === -1) {
        end = nextPosBody;
      } else if (nextPosBody === -1) {
        end = nextPosHeader;
      } else {
        end = Math.min(nextPosHeader, nextPosBody);
      }
      blocks.push(diBodyHtml.slice(start, end));
    }
    if (blocks.length === 0) {
      console.warn('[IPA EXT] No pos-header blocks found');
      return null;
    }
    console.log(`[IPA EXT] Found ${blocks.length} pos-header blocks`);
    return blocks.join('\n').trim();
  } catch (err) {
    console.error('[IPA EXT] extractIPA error:', err);
    return null;
  }
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
