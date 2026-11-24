// ============================================================
// Lectura de tablas nutricionales (texto sacado por OCR)
// ============================================================
// Problemas típicos del OCR que se corrigen aquí:
//  - la "g" de gramos se lee como "9" pegado al número ("18 g" -> "189", "0,5 g" -> "0,59")
//  - la fila "de las cuales saturadas/azúcares" en la misma línea que Grasas/Hidratos
//  - tablas con dos columnas (por 100 g y por ración, en cualquier orden)
//  - kcal mal leídas: se contrastan con los kJ y con 4·P + 4·C + 9·G
(function (root) {
  const strip = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const toNum = (s) => parseFloat(String(s).replace(',', '.'));
  const NUM = /\d+(?:[.,]\d+)?/g;

  function normalizeLine(l) {
    return strip(l)
      .replace(/(?<=\d)[oO](?=[\d,.])|(?<=[,.])[oO](?=\d)|^[oO](?=[,.]\d)/g, '0')
      .replace(/(?<=\d)[lI|](?=\d)/g, '1')
      .replace(/\bpor\s*[il|]\s*00/g, 'por 100')
      .replace(/k\s*c\s*a\s*[l1i|]/g, 'kcal')
      .replace(/(?<=\d)\s*k\s*[ji|1l]\b/g, ' kj')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Números de un trozo de línea. Cada uno: { raw, v, hasG } (hasG = va seguido de una "g" bien leída)
  function numbersIn(seg) {
    const out = []; let m; NUM.lastIndex = 0;
    while ((m = NUM.exec(seg))) {
      const after = seg.slice(m.index + m[0].length, m.index + m[0].length + 4);
      const before = seg.slice(Math.max(0, m.index - 1), m.index);
      if (/^\s*(kj|kcal)/.test(after)) continue;        // energía: se trata aparte
      if (/^\s*%/.test(after)) continue;                 // porcentajes (% VRN)
      if (before === '(' && /^\s*\)?\s*$/.test(after) === false && /raci|porci/.test(seg)) { /* número entre paréntesis: se deja */ }
      out.push({ raw: m[0], v: toNum(m[0]), hasG: /^\s*(g|mg|y|q)\b/.test(after) });
    }
    return out;
  }

  // Candidatos de un valor leído por OCR (después se elige el que cuadra con las calorías):
  //  - tal cual
  //  - sin el "9" final (era la "g" de gramos mal leída)
  //  - con la coma decimal reinsertada ("129" por "1,2 g", "699" por "6,9 g")
  //  - sin un dígito de más al principio (ruido, p. ej. "2309" por "30 g")
  function candidates(tok) {
    const list = [];
    const seen = new Set();
    const add = (str, penalty) => {
      const clean = String(str).replace(/[,.]$/, '');
      if (clean === '' || isNaN(toNum(clean))) return;
      const v = toNum(clean);
      if (seen.has(v)) return;
      seen.add(v); list.push({ v, penalty });
    };
    const endsNine = !tok.hasG && /9$/.test(tok.raw) && tok.raw.replace(/[,.]/, '').length > 1;
    add(tok.raw, endsNine ? 0.04 : 0);                      // lo normal es que ese 9 final sea una "g"
    const bases = [{ s: tok.raw, p: 0 }];
    if (endsNine) { const noG = tok.raw.slice(0, -1); add(noG, 0); bases.push({ s: noG, p: 0 }); }
    for (const b of bases) {
      if (/[,.]/.test(b.s)) continue;
      const d = b.s;
      if (d.length >= 2) add(d.slice(0, -1) + '.' + d.slice(-1), b.p + 0.05);
      if (d.length >= 3) add(d.slice(0, -2) + '.' + d.slice(-2), b.p + 0.06);
      if (d.length >= 3) { add(d.slice(1), b.p + 0.06); if (d.length >= 4) add(d.slice(1, -1) + '.' + d.slice(-1), b.p + 0.08); }
    }
    return list;
  }

  const LABEL = {
    fat:  /^[\W\d_]*gras/,
    carb: /^[\W\d_]*(hidrat|hidr|carbohid|carbohi)/,
    prot: /^[\W\d_]*prote/,
    en:   /^[\W\d_]*(valor\s*)?(ener|valor)/
  };
  const CUT = /\b(de\s+las\s+cuales|de\s+los\s+cuales|las\s+cuales|los\s+cuales|saturad|azucar|monoinsat|poliinsat|trans)/;

  function detectColumns(lines) {
    // { per100Index, rationG, hasTwo, onlyRation }
    for (const l of lines) {
      if (!/\bpor\b|\bpor\s*\d/.test(l) && !/(^|\D)100\s*[g9]\b/.test(l)) continue;
      if (/kcal|kj/.test(l)) continue;
      const parts = l.split(/\bpor\s*(?=[\dil|a-z])/).slice(1);
      if (parts.length) {
        const cols = parts.map(p => {
          let m = p.match(/^(\d{1,4})/);
          let n = m ? Number(m[1]) : null;
          if (n && String(n).length === 4 && String(n).endsWith('9')) n = Number(String(n).slice(0, -1));
          const gm = p.match(/\(\s*(\d+(?:[.,]\d+)?)\s*[g9]/);
          return { n: (n === 100 ? 100 : null), grams: gm ? toNum(gm[1]) : (n && n !== 100 ? n : null) };
        });
        const i100 = cols.findIndex(c => c.n === 100);
        if (i100 >= 0) {
          const ration = cols.find((c, i) => i !== i100 && c.grams);
          return { per100Index: i100, rationG: ration ? ration.grams : null, hasTwo: cols.length > 1 };
        }
        const withG = cols.find(c => c.grams);
        return { per100Index: 0, rationG: withG ? withG.grams : null, hasTwo: false, onlyRation: true };
      }
      return { per100Index: 0, rationG: null, hasTwo: false };   // "100 g" suelto
    }
    return { per100Index: 0, rationG: null, hasTwo: false };
  }

  function rowTokens(lines, i, kind) {
    const l = lines[i];
    const afterLabel = l.replace(/^[\W\d_]*[a-z]+(?:\s+(?:de|total|alimentaria)\s+[a-z]+|\s+[a-z]+(?=\s+\d))?/, (m) => m);
    // quitar el texto del propio nombre (hasta el primer número)
    const firstNum = l.search(/\d/);
    let seg = firstNum >= 0 ? l.slice(firstNum) : '';
    const cut = seg.search(CUT);
    if (cut >= 0) seg = seg.slice(0, cut);
    let toks = numbersIn(seg);
    // valores en las líneas siguientes (tablas donde el número queda debajo del nombre)
    if (!toks.length) {
      for (let j = i + 1; j < Math.min(lines.length, i + 3); j++) {
        if (LABEL.fat.test(lines[j]) || LABEL.carb.test(lines[j]) || LABEL.prot.test(lines[j]) || LABEL.en.test(lines[j])) break;
        if (/^[\W\d_]*(sal|fibra|azucar|de\s+las|de\s+los)/.test(lines[j])) break;
        const t = numbersIn(lines[j]);
        if (t.length) { toks = t; break; }
      }
    }
    return toks;
  }

  function energyIn(lines, colIndex) {
    for (const l of lines) {
      if (!/kcal|kj/.test(l)) continue;
      if (!LABEL.en.test(l) && !/kcal/.test(l)) continue;
      const kcals = [...l.matchAll(/(\d+(?:[.,]\d+)?)\s*kcal/g)].map(m => toNum(m[1]));
      const kjs = [...l.matchAll(/(\d+(?:[.,]\d+)?)\s*kj/g)].map(m => toNum(m[1]));
      if (kcals.length || kjs.length) {
        return { kcals, kjs };
      }
    }
    return { kcals: [], kjs: [] };
  }

  function parseNutritionText(text) {
    const lines = text.split(/\n/).map(normalizeLine).filter(Boolean);
    const cols = detectColumns(lines);
    const ci = cols.per100Index;
    const res = { kcal: null, prot: null, carb: null, fat: null, refG: 100, warnings: [], consistent: null };
    if (cols.onlyRation && cols.rationG) res.refG = cols.rationG;
    if (cols.onlyRation) res.warnings.push(`Los valores de la foto parecen ser por ración (${cols.rationG ? cols.rationG + ' g' : 'tamaño no leído'}).`);

    const found = { fat: null, carb: null, prot: null };
    const inferred = [];
    lines.forEach((l, i) => {
      for (const k of ['fat', 'carb', 'prot']) {
        if (found[k] || !LABEL[k].test(l)) continue;
        if (k === 'fat' && /^[\W\d_]*gras\w*\s+(sat|mono|poli|trans)/.test(l)) continue;
        const toks = rowTokens(lines, i, k);
        if (toks.length) found[k] = toks;
      }
    });
    // Si el OCR no leyó el nombre de una fila, se localiza por su posición en la tabla
    const idxOf = (re, from = 0) => { for (let i = from; i < lines.length; i++) if (re.test(lines[i])) return i; return -1; };
    const rowByPos = (i) => { if (i < 0 || i >= lines.length) return null; const t = rowTokens(lines, i, 'x'); return t.length ? t : null; };
    const iSat = idxOf(/saturad/), iSug = idxOf(/azucar/);
    if (!found.fat && iSat > 0) { const t = rowByPos(iSat - 1); if (t && !/kcal|kj/.test(lines[iSat - 1])) { found.fat = t; inferred.push('fat'); } }
    if (!found.carb && iSug > 0) { const t = rowByPos(iSug - 1); if (t && !/kcal|kj/.test(lines[iSug - 1])) { found.carb = t; inferred.push('carb'); } }
    if (!found.prot && iSug >= 0) {
      for (let j = iSug + 1; j < Math.min(lines.length, iSug + 4); j++) {
        if (/^[\W\d_]*(sal|fibra)/.test(lines[j]) || /^[\W\d_]*(sal|fibra)\b/.test(lines[j])) { if (/fibra/.test(lines[j])) continue; break; }
        const t = rowByPos(j); if (t) { found.prot = t; inferred.push('prot'); break; }
      }
    }
    const en = energyIn(lines, ci);

    const r2 = (x) => Math.round(x * 100) / 100;
    const scaleF = cols.hasTwo && cols.rationG ? 100 / cols.rationG : null;   // ración -> por 100 g
    const oi = ci === 0 ? 1 : 0;                                              // columna "la otra"
    function fieldCands(toks) {
      if (!toks) return [{ v: null, penalty: 0 }];
      const out = [];
      const push = (c, extra) => out.push({ v: c.v, penalty: c.penalty + extra });
      if (toks.length === 1 && scaleF) {                                      // solo se leyó una de las dos columnas
        candidates(toks[0]).forEach(c => push(c, ci === 0 ? 0.02 : 0.06));
        candidates(toks[0]).forEach(c => out.push({ v: r2(c.v * scaleF), penalty: c.penalty + (ci === 0 ? 0.06 : 0.02) }));
      } else {
        const main = toks[Math.min(ci, toks.length - 1)];
        candidates(main).forEach(c => push(c, 0));
        if (scaleF && toks[oi] && toks[oi] !== main) candidates(toks[oi]).forEach(c => out.push({ v: r2(c.v * scaleF), penalty: c.penalty + 0.06 }));
      }
      const seenV = new Map();
      out.forEach(c => { const k = String(c.v); if (!seenV.has(k) || seenV.get(k).penalty > c.penalty) seenV.set(k, c); });
      return [...seenV.values()];
    }
    // energía candidata: kcal leídas y kcal derivadas de los kJ (de ambas columnas)
    const kcalOpts = [];
    const addK = (v, p) => { if (v != null && !isNaN(v) && !kcalOpts.some(o => Math.abs(o.v - v) < 0.5)) kcalOpts.push({ v, penalty: p }); };
    addK(en.kcals[ci], 0); if (en.kcals.length === 1) addK(en.kcals[0], 0);
    if (en.kjs[ci] != null) addK(Math.round(en.kjs[ci] / 4.184), 0.03);
    if (scaleF && en.kcals[oi] != null) addK(Math.round(en.kcals[oi] * scaleF), 0.06);
    if (scaleF && en.kjs[oi] != null) addK(Math.round(en.kjs[oi] / 4.184 * scaleF), 0.08);
    if (!kcalOpts.length) kcalOpts.push({ v: null, penalty: 0 });
    const cF = fieldCands(found.fat), cC = fieldCands(found.carb), cP = fieldCands(found.prot);

    let best = null;
    for (const K of kcalOpts) for (const F of cF) for (const C of cC) for (const P of cP) {
      let score = K.penalty + F.penalty + C.penalty + P.penalty;
      let err = null;
      const parts = [F.v, C.v, P.v];
      if (K.v != null && parts.every(x => x != null)) {
        const calc = 4 * P.v + 4 * C.v + 9 * F.v;
        err = Math.abs(K.v - calc) / Math.max(K.v, 1);
        score += err;
      } else if (K.v != null) score += 0.3;
      if (parts.every(x => x != null) && res.refG === 100 && F.v + C.v + P.v > 101) score += 1;       // imposible por 100 g
      if (F.v != null && F.v > 100 && res.refG === 100) score += 1;
      if (C.v != null && C.v > 100 && res.refG === 100) score += 1;
      if (P.v != null && P.v > 100 && res.refG === 100) score += 1;
      if (!best || score < best.score) best = { score, K, F, C, P, err };
    }
    res.kcal = best.K.v; res.fat = best.F.v; res.carb = best.C.v; res.prot = best.P.v;
    res.uncertain = [...inferred];
    res.err = best.err;
    // un único macro sin leer pero con calorías: se calcula a partir de ellas
    const miss = ['fat', 'carb', 'prot'].filter(k => res[k] == null);
    if (miss.length === 1 && res.kcal != null) {
      const k = miss[0], coef = { fat: 9, carb: 4, prot: 4 };
      const rest = ['fat', 'carb', 'prot'].filter(x => x !== k).reduce((a, x) => a + coef[x] * res[x], 0);
      res[k] = Math.max(0, Math.round((res.kcal - rest) / coef[k] * 10) / 10);
      res.uncertain.push(k);
      res.warnings.push('Un valor no se pudo leer y se ha calculado a partir de las calorías: revísalo.');
    }
    if (best.err != null) {
      res.consistent = best.err <= 0.15;
      if (!res.consistent) res.uncertain.push('kcal', 'prot', 'carb', 'fat');
      else if (best.err > 0.04) res.warnings.push(`Las calorías de la etiqueta y la suma de los macros difieren un ${Math.round(best.err * 100)} %: compara con la foto por si algún número está mal leído.`);
      if (!res.consistent) res.warnings.push('Las calorías no cuadran con proteínas, carbohidratos y grasas: revisa los números.');
    } else if (res.kcal == null && [res.fat, res.carb, res.prot].every(x => x != null)) {
      res.kcal = Math.round(4 * res.prot + 4 * res.carb + 9 * res.fat);
      res.warnings.push('No se leyeron las calorías: se han calculado a partir de los macros.');
    }
    const missing = [['kcal', 'calorías'], ['prot', 'proteínas'], ['carb', 'carbohidratos'], ['fat', 'grasas']].filter(([k]) => res[k] == null).map(x => x[1]);
    if (missing.length) res.warnings.push('No se pudo leer: ' + missing.join(', ') + '.');
    res.score = (4 - missing.length) + (res.consistent ? 2 : 0) - (res.consistent === false ? 1 : 0) - 0.3 * res.uncertain.length;
    return res;
  }

  // Puntuación para comparar varias lecturas de la misma foto: completas, coherentes y con poco desajuste de calorías
  function rankReading(r) { return (r.consistent ? 10 : 0) + r.score - 8 * (r.err == null ? 0.3 : r.err); }
  // ¿Es una lectura tan buena que no hace falta probar otra pasada?
  function isReadingSolid(r) { return r.consistent === true && r.err != null && r.err <= 0.04 && r.warnings.length === 0 && r.uncertain.length === 0; }
  root.rankReading = rankReading; root.isReadingSolid = isReadingSolid;
  root.parseNutritionText = parseNutritionText;
  if (typeof module !== 'undefined' && module.exports) module.exports = { parseNutritionText, rankReading, isReadingSolid };
})(typeof window !== 'undefined' ? window : globalThis);
