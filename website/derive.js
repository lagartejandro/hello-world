// ─────────────────────────────────────────────────────────────────────────────
// Compound food derivation.
//
// A compound food is a list of standard ingredients, each a reference to another
// food — single or compound. Its diet compliance is DERIVED from that graph
// rather than hand-authored, so a dish can never claim a flag its ingredients
// contradict.
//
// Loaded as a plain script by diet-stack.html and read by
// scripts/validate-foods.mjs, so the page and the validator run the same code.
// No build step, no modules, no dependencies.
// ─────────────────────────────────────────────────────────────────────────────
(function (global) {
'use strict';

// Source of truth for which diets exist. diet-stack.html adds labels and colors.
var DIET_KEYS = [
  'low_fodmap', 'gluten_free', 'dairy_free', 'nut_free', 'seed_oil_free',
  'halal', 'kosher', 'pescatarian', 'vegetarian', 'vegan', 'mediterranean',
  'paleo', 'whole30', 'aip', 'atkins', 'keto', 'carnivore'
];

// Kashrut forbids meat and dairy in the same dish however kosher each is alone —
// the one rule here that is a property of the combination, not of an ingredient.
// Dairy is category 'dairy'. Meat is category 'meat' plus these ids, whose
// category hides their animal origin. Fish is deliberately absent: fish with
// dairy is permitted.
var KOSHER_MEAT_DERIVED = [
  'lard', 'tallow', 'duck-fat', 'bone-broth', 'gelatin', 'collagen-peptides',
  'chicken-stock', 'beef-stock'
];

// Thermal nature averages; it does not AND. 'warming' is a stray alias for
// 'warm' on a handful of entries.
var THERMAL = { hot: 2, warm: 1, warming: 1, neutral: 0, cool: -1, cold: -2 };
var BANDS = ['cold', 'cool', 'neutral', 'warm', 'hot'];

// How a food is prepared is most of what TCM judges, and it cannot be read off an
// ingredient list — nigiri and teriyaki salmon share their ingredients. Long, moist
// cooking makes food easy to transform; raw, chilled and deep-fried food is taxing.
var PREP = {
  stewed: 2, steamed: 1.5, boiled: 1, fermented: 1, baked: 0,
  grilled: -0.5, roasted: -0.5, spicy: -0.5,
  raw: -2, chilled: -2, fried: -2
};
var THERMAL_SCORE = { hot: -0.5, warm: 1, neutral: 1, cool: -0.5, cold: -1.5 };

var MAX_FLAVOURS = 4;  // non-thermal flavour tags shown on a compound
var MAX_REASONS = 2;   // ingredients named per failing diet
var MAX_CAVEATS = 2;   // inherited caveats surfaced per passing diet

function isMeat(food) {
  return food.category === 'meat' || KOSHER_MEAT_DERIVED.indexOf(food.id) !== -1;
}

// Would TCM broadly approve of eating this? Scored from the thermal band, the
// preparation, and how damp-forming the thing is. Serves single foods and
// compounds alike, so a card always has a verdict.
function tcmVerdict(properties, prep) {
  properties = properties || [];
  prep = prep || [];
  var reasons = [];   // { weight, text } — the strongest two are shown

  var prepScore = 0;
  prep.forEach(function (p) { if (PREP.hasOwnProperty(p)) prepScore += PREP[p]; });
  prepScore = Math.max(-3, Math.min(3, prepScore));

  var has = function (p) { return prep.indexOf(p) !== -1; };
  if (has('raw') && has('chilled')) reasons.push({ weight: -4, text: 'Raw and chilled \u2014 taxing for Spleen Yang' });
  else if (has('raw'))              reasons.push({ weight: -2, text: 'Raw \u2014 harder for the Spleen to transform' });
  else if (has('chilled'))          reasons.push({ weight: -2, text: 'Served cold \u2014 slows digestion' });
  if (has('fried'))                 reasons.push({ weight: -2, text: 'Deep-fried and greasy \u2014 damp-forming' });
  if (has('stewed') || has('boiled')) reasons.push({ weight: 2, text: 'Long-cooked \u2014 easy to digest' });
  if (has('steamed'))               reasons.push({ weight: 1.5, text: 'Gently steamed \u2014 easy to digest' });
  if (has('fermented'))             reasons.push({ weight: 1, text: 'Fermented \u2014 aids digestion' });
  if (has('spicy'))                 reasons.push({ weight: -0.5, text: 'Pungent and heating' });

  var thermal = null;
  properties.forEach(function (p) { if (THERMAL.hasOwnProperty(p) && !thermal) thermal = p; });
  if (thermal === 'warming') thermal = 'warm';
  var thermalScore = thermal ? THERMAL_SCORE[thermal] : 0;
  if (thermal === 'cold')      reasons.push({ weight: -1.5, text: 'Cold in nature \u2014 best balanced with something warming' });
  else if (thermal === 'hot')  reasons.push({ weight: -0.5, text: 'Strongly heating' });
  else if (thermal === 'warm') reasons.push({ weight: 1, text: 'Warming' });
  else if (thermal === 'neutral') reasons.push({ weight: 1, text: 'Neutral in nature — easy to tolerate' });

  var damp = 0;
  properties.forEach(function (p) { if (p.indexOf('damp') !== -1) damp++; });
  var dampPenalty = Math.max(-2, -damp);
  if (damp) reasons.push({ weight: dampPenalty, text: 'Damp-forming' });

  var score = prepScore + thermalScore + dampPenalty;
  // A single ingredient has no preparation, so nature alone caps at 1 — hold it to
  // a lower bar or nothing raw from the earth could ever read as supportive.
  var goodAt = prep.length ? 1.5 : 1;
  var level = score >= goodAt ? 'good' : (score > -1 ? 'neutral' : 'bad');
  var label = level === 'good' ? 'Supportive'
            : level === 'neutral' ? 'Fine in moderation'
            : 'Not recommended';

  // Lead with whatever weighs most, in the direction the verdict went.
  var wanted = level === 'good' ? 1 : -1;
  var picked = reasons
    .filter(function (r) { return (r.weight > 0 ? 1 : -1) === wanted; })
    .sort(function (a, b) { return Math.abs(b.weight) - Math.abs(a.weight); })
    .slice(0, 2);
  if (!picked.length) picked = reasons.slice(0, 1);
  if (!picked.length) picked = [{ text: 'Neither especially strengthening nor taxing' }];

  return {
    level: level,
    label: label,
    score: score,
    reason: picked.map(function (r) { return r.text; }).join('; ')
  };
}

// Average the thermal natures and snap to the nearest band, then keep the flavour
// tags by how often they recur — capped, so a fifteen-ingredient dish doesn't turn
// into fifteen tags, but not so strict that it shows almost nothing.
function aggregateTcm(leaves, ownPrep) {
  var sum = 0, n = 0, counts = {}, order = [], prep = [], prepSeen = {};
  (ownPrep || []).forEach(function (p) {
    if (!prepSeen[p]) { prepSeen[p] = true; prep.push(p); }
  });
  leaves.forEach(function (f) {
    (f.tcm_properties || []).forEach(function (p) {
      if (THERMAL.hasOwnProperty(p)) { sum += THERMAL[p]; n++; return; }
      if (!counts[p]) { counts[p] = 0; order.push(p); }
      counts[p]++;
    });
    // A dish built on ice cream is chilled whether or not it says so.
    (f.prep || []).forEach(function (p) {
      if (!prepSeen[p]) { prepSeen[p] = true; prep.push(p); }
    });
  });
  var thermal = [];
  if (n > 0) thermal.push(BANDS[Math.max(0, Math.min(4, Math.round(sum / n) + 2))]);
  order.sort(function (a, b) { return counts[b] - counts[a]; });
  return {
    properties: thermal.concat(order.slice(0, MAX_FLAVOURS)),
    prep: prep,
    verdict: tcmVerdict(thermal.concat(order), prep)
  };
}

function derive(foods, compounds) {
  var singles = {}, byCompound = {}, errors = [];
  foods.forEach(function (f) { singles[f.id] = f; });
  compounds.forEach(function (c) { byCompound[c.id] = c; });

  var memo = {}, inProgress = {};

  function nameOf(id) {
    return (singles[id] || byCompound[id] || { name: id }).name;
  }

  // Leaves of the ingredient graph, each mapped to the direct child it came
  // through (null when it is a direct ingredient). Used for TCM aggregation and
  // for the kosher meat+dairy scan, both of which are properties of the whole
  // dish rather than of any one step.
  function leafClosure(refs, ownerId) {
    var seen = {}, order = [];
    refs.forEach(function (ref) {
      var id = ref.ref;
      if (singles[id]) {
        if (!(id in seen)) { seen[id] = null; order.push(id); }
      } else if (byCompound[id]) {
        var sub = resolve(id);
        if (!sub) return;
        sub.leafOrder.forEach(function (leafId) {
          if (!(leafId in seen)) { seen[leafId] = id; order.push(leafId); }
        });
      } else {
        errors.push(ownerId + ': ingredient "' + id + '" matches no food or compound');
      }
    });
    return { via: seen, order: order };
  }

  // Whether one ingredient satisfies one diet, and if not, which leaves to blame.
  // A compound ingredient answers with its own RESOLVED verdict, so an override
  // on a shared base is respected by every dish built from it.
  function checkIngredient(ref, key) {
    var leaf = singles[ref];
    if (leaf) {
      if (leaf[key]) return { pass: true, caveat: leaf[key + '_caveat'] || null, from: leaf.name };
      return { pass: false, blame: [{ id: ref, name: leaf.name, via: null }] };
    }
    var child = memo[ref] || resolve(ref);
    if (!child) return { pass: true };
    if (child[key]) return { pass: true, caveat: child[key + '_caveat'] || null, from: child.name };
    var inner = child.failReasons[key];
    if (inner && inner.length) {
      return {
        pass: false,
        blame: inner.map(function (b) {
          return { id: b.id, name: b.name, via: ref, viaName: child.name };
        })
      };
    }
    // The child failed for a reason of its own — an override, or the kosher
    // combination rule — so the child itself is the thing to name.
    return { pass: false, blame: [{ id: ref, name: child.name, via: null }] };
  }

  function resolve(id) {
    if (memo[id]) return memo[id];
    if (inProgress[id]) { errors.push('cycle in ingredients at "' + id + '"'); return null; }
    var c = byCompound[id];
    if (!c) return null;
    inProgress[id] = true;

    var ingredients = c.ingredients || [];
    var closure = leafClosure(ingredients, id);
    var leaves = closure.order.map(function (l) { return singles[l]; });

    var flags = {}, failReasons = {}, caveats = {};
    DIET_KEYS.forEach(function (key) {
      var blame = [], notes = [];
      ingredients.forEach(function (ing) {
        var r = checkIngredient(ing.ref, key);
        if (r.pass) { if (r.caveat) notes.push({ text: r.caveat, from: r.from }); }
        else blame = blame.concat(r.blame);
      });
      flags[key] = blame.length === 0;
      if (blame.length) failReasons[key] = blame.slice(0, MAX_REASONS);
      // A caveat only reads as a caveat while the diet still passes; once it
      // fails, the named ingredients say more than portion advice would.
      else if (notes.length) caveats[key] = notes.slice(0, MAX_CAVEATS);
    });

    // Emergent rule: meat and dairy in the same dish. Scanned over the whole
    // closure, since the pair can sit in two different bases.
    var kosherCombo = null;
    if (flags.kosher) {
      // Name the salient pair. A dish's own ingredients say more than a trace of
      // butter inside one of its bases, so direct ingredients are preferred: a
      // cheeseburger reads "ground beef + cheddar", not "+ butter from the bun".
      var pick = function (test) {
        var direct = null, nested = null;
        closure.order.forEach(function (leafId) {
          var leaf = singles[leafId];
          if (!test(leaf)) return;
          if (closure.via[leafId] === null) { if (!direct) direct = leaf; }
          else if (!nested) nested = leaf;
        });
        return direct || nested;
      };
      var meat = pick(isMeat);
      var dairy = pick(function (leaf) { return leaf.category === 'dairy'; });
      if (meat && dairy) {
        flags.kosher = false;
        delete caveats.kosher;
        kosherCombo = { meat: meat.name, dairy: dairy.name };
      }
    }

    // Optional ingredients never change the verdict; they are reported so the
    // reader can check the version in front of them.
    var optionalRisks = (c.optional || []).map(function (o) {
      var breaks = DIET_KEYS.filter(function (key) { return !checkIngredient(o.ref, key).pass; });
      return { id: o.ref, name: nameOf(o.ref), note: o.note || null, breaks: breaks };
    });

    // Overrides win, and must say why.
    var overrideNotes = [];
    Object.keys(c.overrides || {}).forEach(function (key) {
      var o = c.overrides[key];
      overrideNotes.push({ key: key, value: o.value, reason: o.reason, was: flags[key] });
      flags[key] = o.value;
      delete failReasons[key];
      delete caveats[key];
      if (key === 'kosher') kosherCombo = null;
    });

    var tcm = aggregateTcm(leaves, c.prep);
    var out = {
      id: c.id,
      name: c.name,
      aka: c.aka || null,
      category: c.type,
      type: c.type,
      compound: true,
      tcm_properties: tcm.properties,
      prep: tcm.prep,
      tcm_verdict: tcm.verdict,
      tcm_notes: c.tcm_notes || '',
      tcm_approx: true,
      leafOrder: closure.order,
      failReasons: failReasons,
      kosherCombo: kosherCombo,
      optionalRisks: optionalRisks,
      overrideNotes: overrideNotes,
      ingredients: ingredients.map(function (ing) {
        var sub = byCompound[ing.ref];
        return {
          id: ing.ref,
          name: nameOf(ing.ref),
          compound: !!sub,
          // One level deep only — deeper graphs become a wall of text.
          children: sub ? (sub.ingredients || []).map(function (g) { return nameOf(g.ref); }) : null
        };
      })
    };
    DIET_KEYS.forEach(function (key) {
      out[key] = flags[key];
      out[key + '_caveat'] = caveats[key]
        ? caveats[key].map(function (n) {
            return n.text.replace(/\.$/, '') + ' — from ' + n.from.toLowerCase();
          }).join('; ')
        : null;
    });

    inProgress[id] = false;
    memo[id] = out;
    return out;
  }

  var resolved = [];
  compounds.forEach(function (c) {
    var r = resolve(c.id);
    if (r) resolved.push(r);
  });
  return { resolved: resolved, errors: errors };
}

var api = {
  DIET_KEYS: DIET_KEYS,
  KOSHER_MEAT_DERIVED: KOSHER_MEAT_DERIVED,
  PREP: PREP,
  THERMAL: THERMAL,
  tcmVerdict: tcmVerdict,
  derive: derive
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
global.DietStackDerive = api;

})(typeof globalThis !== 'undefined' ? globalThis : this);
