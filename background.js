const CAMBRIDGE_ORIGIN = 'https://dictionary.cambridge.org';

function isChallenge(status, text) {
  return status === 403 || /<title>\s*Just a moment/i.test(text || '');
}

// 先在后台直接请求；被 Cloudflare 拦截时，改到剑桥标签页里请求（同源，带用户已通过验证的会话）
async function cambridgeFetch(url, asBase64) {
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (asBase64) {
      if (res.ok) return { status: res.status, body: arrayBufferToBase64(await res.arrayBuffer()) };
    } else {
      const text = await res.text();
      if (!isChallenge(res.status, text)) return { status: res.status, body: text };
    }
    console.warn('[IPA EXT] Direct fetch blocked (HTTP', res.status, '), retrying via Cambridge tab');
  } catch (err) {
    console.warn('[IPA EXT] Direct fetch failed, retrying via Cambridge tab:', err);
  }
  return fetchViaCambridgeTab(url, asBase64);
}

async function getCambridgeTab() {
  const tabs = await chrome.tabs.query({ url: `${CAMBRIDGE_ORIGIN}/*` });
  const ready = tabs.find(t => t.status === 'complete') || tabs[0];
  if (ready) return { tab: ready, created: false };
  const tab = await chrome.tabs.create({ url: `${CAMBRIDGE_ORIGIN}/`, active: false });
  await waitForTabComplete(tab.id);
  return { tab, created: true };
}

function waitForTabComplete(tabId, timeoutMs = 20000) {
  return new Promise(resolve => {
    const done = () => { chrome.tabs.onUpdated.removeListener(listener); clearTimeout(timer); resolve(); };
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    const timer = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(t => { if (t.status === 'complete') done(); }).catch(done);
  });
}

async function fetchViaCambridgeTab(url, asBase64) {
  const { tab, created } = await getCambridgeTab();
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [url, asBase64],
    func: async (url, asBase64) => {
      try {
        const res = await fetch(url, { credentials: 'include' });
        if (!asBase64) return { status: res.status, body: await res.text() };
        const bytes = new Uint8Array(await res.arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        return { status: res.status, body: btoa(binary) };
      } catch (err) {
        return { status: 0, body: '', error: String(err && err.message || err) };
      }
    },
  });
  const result = (injection && injection.result) || { status: 0, body: '', error: 'executeScript 无返回' };
  result.viaTab = true;
  // 剑桥标签页本身还停在验证页：激活它让用户完成验证
  if (!asBase64 && isChallenge(result.status, result.body)) {
    chrome.tabs.update(tab.id, { active: true });
    if (created) chrome.tabs.reload(tab.id);
  }
  return result;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'FETCH_IPA') {
    const word = encodeURIComponent(message.word);
    const url = `${CAMBRIDGE_ORIGIN}/dictionary/english-chinese-simplified/${word}`;
    console.log('[IPA EXT] Fetching URL:', url);
    cambridgeFetch(url, false)
      .then(({ status, body: html, error, viaTab }) => {
        if (error) {
          sendResponse({ipa: null, error: `请求失败 (HTTP ${status}${viaTab ? ', 经剑桥标签页' : ''}): ${error}`});
          return;
        }
        if (isChallenge(status, html)) {
          console.warn('[IPA EXT] Still blocked by Cloudflare challenge, HTTP', status);
          sendResponse({ipa: null, challenge: true});
          return;
        }
        const ipa = extractIPA(html);
        if (!ipa) {
          console.warn('[IPA EXT] IPA not found for', message.word);
          const title = (html.match(/<title>([^<]*)/i) || [])[1] || '';
          sendResponse({ipa: null, error: `解析失败 (HTTP ${status}, ${html.length} 字节, 标题: ${title.trim().slice(0, 80)})`});
          return;
        }
        console.log('[IPA EXT] IPA found', viaTab ? '(via Cambridge tab)' : '');
        sendResponse({ipa});
      })
      .catch((err) => {
        console.error('[IPA EXT] Fetch error:', err);
        sendResponse({ipa: null, error: `请求失败: ${err && err.message}`});
      });
    return true; // Indicate async response
  }

  if (message.type === 'FETCH_MP3_PROXY' && message.url) {
    cambridgeFetch(message.url, true)
      .then(({ status, body, error }) => {
        if (error || status < 200 || status >= 300) {
          console.error('[IPA EXT] MP3 fetch failed:', status, error);
          sendResponse({ base64: null });
          return;
        }
        sendResponse({ base64: body });
      })
      .catch(err => {
        console.error('[IPA EXT] MP3 proxy fetch error:', err);
        sendResponse({ base64: null });
      });
    return true;
  }
});

// 提取最外层 <span class="trans dtrans dtrans-se  break-cj" lang="zh-Hans"> ... </span>，支持嵌套
function extractOuterZhTransSpans(html) {
  let processedHtml = html;
  if (Array.isArray(html) && html.length > 0) {
    processedHtml = html[0];
  }

  const results = [];
  const openTag = '<span class="trans dtrans dtrans-se  break-cj" lang="zh-Hans">';
  let idx = 0;
  while ((idx = processedHtml.indexOf(openTag, idx)) !== -1) {
    let start = idx + openTag.length;
    let end = start;
    let depth = 1;
    // 从start开始查找配对的</span>
    while (depth > 0) {
      const nextOpen = processedHtml.indexOf('<span', end);
      const nextClose = processedHtml.indexOf('</span>', end);
      if (nextClose === -1) break; // 没有闭合，直接退出
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++;
        end = nextOpen + 5;
      } else {
        depth--;
        end = nextClose + 7;
      }
    }
    if (depth === 0) {
      const content = processedHtml.slice(start, end - 7);
      results.push(content);
      idx = end;
    } else {
      // 没有配对，防止死循环
      break;
    }
  }
  return results;
}

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
    let result = blocks.join('\n').trim();
    // --- 追加英文释义和中文释义 ---
    const posBodyToDefSrcRegex = /<div class="pos-body">([\s\S]*?)(?=<div class="definition-src ddef-src lbt lb-cm lpb-10">)/g;
    const posBodyHtml = html.match(posBodyToDefSrcRegex);
    if (!posBodyHtml) {
      console.warn('[IPA EXT] No pos-body to def-src found');
      return null;
    }
    console.log('[IPA EXT] pos-body to def-src found');
    console.log('[IPA EXT] posBodyHtml:', posBodyHtml);
 
      // 英文释义
    let defList = [];
    const defRegex = /<div class="def ddef_d db">([\s\S]*?)<\/div>/g;
    let m;
    let defMatchCount = 0;
    while ((m = defRegex.exec(posBodyHtml)) !== null) {
      let defHtml = m[1];
      defHtml = defHtml.replace(/<a[^>]*>([\s\S]*?)<\/a>/g, '$1');
      defHtml = defHtml.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if(defHtml) defList.push(defHtml);
      defMatchCount++;
    }
    console.log(`[IPA EXT] defRegex match count: ${defMatchCount}`);
    if (defList.length) {
      console.log('[IPA EXT] Extracted English definitions:', defList.slice(0, 3));
      result += '<br>' + defList.map(d => `<div>${d}</div>`).join('');
    } else {
      console.warn('[IPA EXT] No English definitions extracted');
    }
    // 中文释义
    let transList = [];
    // 用 extractOuterZhTransSpans 提取最外层中文释义（函数已移到文件最外层）
    const zhTransSpans = extractOuterZhTransSpans(posBodyHtml);
    for (let content of zhTransSpans) {
      let zhHtml = content.replace(/<a[^>]*>([\s\S]*?)<\/a>/g, '$1');
      zhHtml = zhHtml.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (zhHtml) transList.push(zhHtml);
    }
    console.log(`[IPA EXT] transRegex match count: ${zhTransSpans.length}`);
    if (transList.length) {
      console.log('[IPA EXT] Extracted Chinese translations:', transList.slice(0, 3));
      result += transList.map(t => `<div>${t}</div>`).join('');
    } else {
      console.warn('[IPA EXT] No Chinese translations extracted');
    }
    return result.trim();
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
