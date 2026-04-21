// Builds a trie of card names and scans plaintext for longest matches.
//
// Names are indexed lowercased. Matches require a non-word character (or string
// boundary) before and after, so "Bolt" won't match inside "Bolts". Matches may
// contain spaces, apostrophes, commas, colons, and hyphens, which is why we
// can't just use \b regexes everywhere.
(function () {
  const CM = (window.CM = window.CM || {});

  const WORD_CHAR = /[A-Za-z0-9]/;

  function normalize(s) {
    // Lowercase + collapse Unicode Æ/æ to plain "ae" so "Æther Vial" matches.
    return s
      .toLowerCase()
      .replace(/æ/g, "ae")
      .replace(/\u2019/g, "'"); // curly apostrophe -> straight
  }

  function makeTrie(names) {
    const root = { c: new Map(), t: null };
    for (const original of names) {
      if (!original || original.length < 3) continue;
      const key = normalize(original);
      let node = root;
      for (let i = 0; i < key.length; i++) {
        const ch = key[i];
        let child = node.c.get(ch);
        if (!child) {
          child = { c: new Map(), t: null };
          node.c.set(ch, child);
        }
        node = child;
      }
      // Store the canonical name. If there's a collision, keep the first.
      if (!node.t) node.t = original;
    }
    return root;
  }

  // Scan a plain string for all non-overlapping matches.
  // Returns [{start, end, name}] where name is the canonical card name.
  function findAll(trie, text) {
    const norm = normalize(text);
    const out = [];
    const len = norm.length;
    let i = 0;
    while (i < len) {
      // Require a word boundary before the match.
      const prev = i > 0 ? norm[i - 1] : "";
      if (prev && WORD_CHAR.test(prev)) { i++; continue; }
      if (!WORD_CHAR.test(norm[i])) { i++; continue; }

      // Walk the trie, remembering the longest terminal we see.
      let node = trie;
      let j = i;
      let bestEnd = -1;
      let bestName = null;
      while (j < len) {
        const child = node.c.get(norm[j]);
        if (!child) break;
        node = child;
        j++;
        if (node.t) {
          // Require a word boundary after the match too.
          const next = j < len ? norm[j] : "";
          if (!next || !WORD_CHAR.test(next)) {
            bestEnd = j;
            bestName = node.t;
          }
        }
      }

      if (bestEnd > i) {
        out.push({ start: i, end: bestEnd, name: bestName });
        i = bestEnd;
      } else {
        // Skip this word.
        while (i < len && WORD_CHAR.test(norm[i])) i++;
        while (i < len && !WORD_CHAR.test(norm[i])) i++;
      }
    }
    return out;
  }

  CM.matcher = { makeTrie, findAll, normalize };
})();
