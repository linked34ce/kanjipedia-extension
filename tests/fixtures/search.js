// Synthetic structural fixtures; no downloaded page is redistributed.
export const row = (heading = '白亜', reading = 'ハクア', id = '0005614200') =>
  `<li><a href="/kotoba/${id}">${heading}<br><span>(${reading})</span></a></li>`;
export function searchFixture({
  prefix = 'あ',
  page = 1,
  total = 1,
  last = 1,
  rows = row(),
  links = '',
} = {}) {
  return `<ul id="resultCondition"><li>検索ワード：${prefix}</li><li>絞り込み：「言葉のよみ」</li><li>検索条件：「～で始まる」</li></ul>
    <div id="resultCount">言葉：${total}件</div><ul id="resultKotobaList">${rows}</ul>
    <div class="pagerSection"><span class="pageOn current"><a>${page}</a></span>
      <a href="/search?k=${prefix}&amp;wy=1&amp;sk=leftHand" rel="first">最初</a>
      <a href="/search?k=${prefix}&amp;wy=1&amp;sk=leftHand&amp;page=${last}" rel="last">最後</a>${links}</div>`;
}
