const ordinary =
  'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわ';
const additional =
  'がぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽゐゑをんぁぃぅぇぉっゃゅょゎゕゖゔ';
export const PREFIXES = [...(ordinary + additional)].map((prefix) => ({
  prefix,
  status: 'target',
  verification: 'unconfirmed',
  reason: '清音への包含を仮定せず独立に確認する',
}));
