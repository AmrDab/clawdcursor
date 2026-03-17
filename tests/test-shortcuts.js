#!/usr/bin/env node
const { findShortcut } = require('./dist/shortcuts');

const samples = [
  ['scroll down'],
  ['go to top'],
  ['newtab'],
  ['refesh'],
  ['upvote'],
  ['upvote', { contextHint: 'reddit.com feed' }],
  ['lock screen'],
  ['non matching intent'],
];

for (const [input, options] of samples) {
  const match = findShortcut(input, process.platform, options);
  if (!match) {
    console.log(`${input} -> no match`);
    continue;
  }

  console.log(`${input} -> ${match.combo} (${match.canonicalIntent}, ${match.matchType})`);
}
