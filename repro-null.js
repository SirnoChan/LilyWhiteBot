'use strict';
// 服务器端复现：convert 的 jina-markdown 分支（真实 jina markdown 样本）
const fs = require('fs');
(async () => {
  const html = fs.readFileSync('/tmp/jina-test.txt', 'utf8');  // 真实 jina markdown
  const url = 'https://www.zhihu.com/question/48082706/answer/26271872131';
  const { JSDOM } = require('jsdom');
  const { Readability } = require('@mozilla/readability');
  const cheerio = require('cheerio');

  const dom = new JSDOM(html, { url });
  let article = new Readability(dom.window.document).parse();
  console.log('readability:', article ? 'ok' : 'null');
  const docTitle = dom.window.document.title || '';
  console.log('docTitle:', JSON.stringify(docTitle.slice(0, 40)));

  const metaAuthor = (() => {
    const $h = cheerio.load(html);
    const m = $h('meta[property="article:author"]').attr('content')
        || $h('meta[name="author"]').attr('content')
        || $h('meta[name="twitter:creator"]').attr('content');
    return (m || '').trim();
  })();
  console.log('metaAuthor:', JSON.stringify(metaAuthor));

  let jinaTitle = '';
  if (!article || !article.content) {
    jinaTitle = (html.match(/^Title:\s*(.+)$/mu) || [])[1] || '';
  }
  console.log('jinaTitle:', JSON.stringify(jinaTitle.slice(0, 50)));

  // 署名链（复刻 replyRef 调用前的署名计算）
  const cleanByline = (s) => (s || '').trim();
  const authorFromTitle = (t) => {
    const m = (t || '').match(/[-–—]\s*(.{1,30}?)\s*的回答\s*$/u);
    return m && m[1];
  };
  const byline = cleanByline(authorFromTitle(docTitle)
      || (article.byline && article.byline !== docTitle ? article.byline : '')
      || metaAuthor
      || ((jinaTitle.match(/[-–—]\s*(.{1,30}?)\s*的(?:回答|文章)\s*$/u) || [])[1] || ''));
  console.log('byline:', JSON.stringify(byline));
  process.exit(0);
})().catch(e => console.error('CAUGHT:', e.message));
