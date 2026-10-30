// blocks.js — Rafter material catalog (ENGINE owns).
// Plain ES module, no DOM. Consumed by engine.js, textures.js, app.js, plans.js.
//
// Every family: { name, full, slab, stairs, wall, color, group, pattern }
//   full/slab/stairs/wall are real vanilla block ids ("minecraft:..."), or null when
//   the variant does not exist in vanilla 1.21.
//   color   = approximate average top-face colour (hex) used for plans + viewer tint.
//   pattern = procedural texture name understood by textures.js (see SPEC).

const MC = 'minecraft:';

/** Planks family: X_planks / X_slab / X_stairs, no wall. */
function planks(key, name, color) {
  return { name, full: MC + key + '_planks', slab: MC + key + '_slab', stairs: MC + key + '_stairs', wall: null, color, group: 'Wood', pattern: 'planks' };
}

/**
 * Stone-like family. `base` is the full-block id (without namespace); slab/stairs/wall
 * ids are derived from `stem` (singular form, e.g. "stone_brick" for "stone_bricks").
 */
function stone(name, base, stem, { wall = false, color, group = 'Stone', pattern = 'stone', slab = true, stairs = true } = {}) {
  return {
    name,
    full: MC + base,
    slab: slab ? MC + stem + '_slab' : null,
    stairs: stairs ? MC + stem + '_stairs' : null,
    wall: wall ? MC + stem + '_wall' : null,
    color, group, pattern,
  };
}

/** Full-only family (logs, terracotta, concrete, wool). */
function fullOnly(name, id, color, group, pattern) {
  return { name, full: MC + id, slab: null, stairs: null, wall: null, color, group, pattern };
}

const WOODS = [
  ['oak', 'Oak', '#b8945f', '#6e5a35', '#b39b63'],
  ['spruce', 'Spruce', '#6b4a2b', '#3b2611', '#745a35'],
  ['birch', 'Birch', '#d7cb8d', '#c9c7bf', '#c6b177'],
  ['jungle', 'Jungle', '#b88764', '#554419', '#ab8a5a'],
  ['acacia', 'Acacia', '#ba6337', '#676157', '#ad5d32'],
  ['dark_oak', 'Dark oak', '#432b14', '#3c2d18', '#4b3a21'],
  ['mangrove', 'Mangrove', '#763632', '#574233', '#78392f'],
  ['cherry', 'Cherry', '#e3b4ad', '#36212a', '#d7a4a0'],
  ['bamboo', 'Bamboo', '#c5b14a', '#8c9c3c', '#c3b14e'],
  ['crimson', 'Crimson', '#6a324b', '#5d1a3f', '#7c3a5a'],
  ['warped', 'Warped', '#2c6b64', '#3a3c4e', '#3a9690'],
  ['pale_oak', 'Pale oak', '#ded8d2', '#5c4a45', '#f3ece4'],
];

/** Vanilla "log" id for a wood key (stems for nether woods, block for bamboo). */
function logId(key) {
  if (key === 'crimson' || key === 'warped') return key + '_stem';
  if (key === 'bamboo') return 'bamboo_block';
  return key + '_log';
}
function logName(key, label) {
  if (key === 'crimson' || key === 'warped') return label + ' stem';
  if (key === 'bamboo') return 'Bamboo block';
  return label + ' log';
}

const DYES = [
  ['white', 'White', '#d1b2a1', '#cfd5d6', '#e9ecec'],
  ['orange', 'Orange', '#a15325', '#e06101', '#f07613'],
  ['magenta', 'Magenta', '#95586c', '#a9309f', '#bd44b3'],
  ['light_blue', 'Light blue', '#716c89', '#2389c7', '#3aafd9'],
  ['yellow', 'Yellow', '#ba8523', '#f1af15', '#f8c627'],
  ['lime', 'Lime', '#677534', '#5ea918', '#70b919'],
  ['pink', 'Pink', '#a04d4e', '#d5658f', '#ed8dac'],
  ['gray', 'Gray', '#392a23', '#36393d', '#3e4447'],
  ['light_gray', 'Light gray', '#876a61', '#7d7d73', '#8e8e86'],
  ['cyan', 'Cyan', '#565b5b', '#157788', '#158991'],
  ['purple', 'Purple', '#764656', '#64209c', '#792aac'],
  ['blue', 'Blue', '#4a3b5b', '#2d2f8f', '#35399d'],
  ['brown', 'Brown', '#4d3323', '#603c20', '#724728'],
  ['green', 'Green', '#4b522a', '#495b24', '#546d1b'],
  ['red', 'Red', '#8f3d2e', '#8e2121', '#a12722'],
  ['black', 'Black', '#251610', '#080a0f', '#141519'],
];

export const FAMILIES = {};

// ---- Wood planks (slab + stairs) -------------------------------------------------
for (const [key, label, color] of WOODS) FAMILIES[key] = { ...planks(key, label + ' planks', color), door: MC + key + '_door', trapdoor: MC + key + '_trapdoor' };

// ---- Stone family --------------------------------------------------------------
Object.assign(FAMILIES, {
  stone: stone('Stone', 'stone', 'stone', { color: '#7e7e7e', pattern: 'stone' }),
  cobblestone: stone('Cobblestone', 'cobblestone', 'cobblestone', { wall: true, color: '#828282', pattern: 'cobble' }),
  mossy_cobblestone: stone('Mossy cobblestone', 'mossy_cobblestone', 'mossy_cobblestone', { wall: true, color: '#6a7a5a', pattern: 'cobble' }),
  stone_bricks: stone('Stone bricks', 'stone_bricks', 'stone_brick', { wall: true, color: '#7a7a7a', pattern: 'stone_bricks' }),
  mossy_stone_bricks: stone('Mossy stone bricks', 'mossy_stone_bricks', 'mossy_stone_brick', { wall: true, color: '#737d63', pattern: 'stone_bricks' }),
  andesite: stone('Andesite', 'andesite', 'andesite', { wall: true, color: '#868686', pattern: 'stone' }),
  polished_andesite: stone('Polished andesite', 'polished_andesite', 'polished_andesite', { color: '#848687', pattern: 'smooth' }),
  diorite: stone('Diorite', 'diorite', 'diorite', { wall: true, color: '#bdbdbe', pattern: 'stone' }),
  polished_diorite: stone('Polished diorite', 'polished_diorite', 'polished_diorite', { color: '#c2c2c3', pattern: 'smooth' }),
  granite: stone('Granite', 'granite', 'granite', { wall: true, color: '#956556', pattern: 'stone' }),
  polished_granite: stone('Polished granite', 'polished_granite', 'polished_granite', { color: '#9a6b5a', pattern: 'smooth' }),
  smooth_stone: stone('Smooth stone', 'smooth_stone', 'smooth_stone', { color: '#a0a0a0', pattern: 'smooth', stairs: false }),

  // Dark stone: blackstone, deepslate, tuff
  blackstone: stone('Blackstone', 'blackstone', 'blackstone', { wall: true, color: '#2a252c', group: 'Dark stone', pattern: 'stone' }),
  polished_blackstone: stone('Polished blackstone', 'polished_blackstone', 'polished_blackstone', { wall: true, color: '#353039', group: 'Dark stone', pattern: 'smooth' }),
  polished_blackstone_bricks: stone('Polished blackstone bricks', 'polished_blackstone_bricks', 'polished_blackstone_brick', { wall: true, color: '#302b33', group: 'Dark stone', pattern: 'stone_bricks' }),
  cobbled_deepslate: stone('Cobbled deepslate', 'cobbled_deepslate', 'cobbled_deepslate', { wall: true, color: '#4d4d50', group: 'Dark stone', pattern: 'cobble' }),
  polished_deepslate: stone('Polished deepslate', 'polished_deepslate', 'polished_deepslate', { wall: true, color: '#484849', group: 'Dark stone', pattern: 'smooth' }),
  deepslate_bricks: stone('Deepslate bricks', 'deepslate_bricks', 'deepslate_brick', { wall: true, color: '#474748', group: 'Dark stone', pattern: 'stone_bricks' }),
  deepslate_tiles: stone('Deepslate tiles', 'deepslate_tiles', 'deepslate_tile', { wall: true, color: '#363637', group: 'Dark stone', pattern: 'tiles' }),
  tuff: stone('Tuff', 'tuff', 'tuff', { wall: true, color: '#6c6d67', group: 'Dark stone', pattern: 'stone' }),
  polished_tuff: stone('Polished tuff', 'polished_tuff', 'polished_tuff', { wall: true, color: '#62665f', group: 'Dark stone', pattern: 'smooth' }),
  tuff_bricks: stone('Tuff bricks', 'tuff_bricks', 'tuff_brick', { wall: true, color: '#656a62', group: 'Dark stone', pattern: 'stone_bricks' }),

  // Bricks
  bricks: stone('Bricks', 'bricks', 'brick', { wall: true, color: '#976153', group: 'Bricks', pattern: 'bricks' }),
  nether_bricks: stone('Nether bricks', 'nether_bricks', 'nether_brick', { wall: true, color: '#2d1619', group: 'Bricks', pattern: 'bricks' }),
  red_nether_bricks: stone('Red nether bricks', 'red_nether_bricks', 'red_nether_brick', { wall: true, color: '#460709', group: 'Bricks', pattern: 'bricks' }),
  mud_bricks: stone('Mud bricks', 'mud_bricks', 'mud_brick', { wall: true, color: '#8a6a52', group: 'Bricks', pattern: 'mud' }),
  resin_bricks: stone('Resin bricks', 'resin_bricks', 'resin_brick', { wall: true, color: '#c45f2a', group: 'Bricks', pattern: 'bricks' }),
  end_stone_bricks: stone('End stone bricks', 'end_stone_bricks', 'end_stone_brick', { wall: true, color: '#dbe0a2', group: 'Bricks', pattern: 'stone_bricks' }),

  // Sandstone
  sandstone: stone('Sandstone', 'sandstone', 'sandstone', { wall: true, color: '#dbcf9e', group: 'Sandstone', pattern: 'sandstone' }),
  smooth_sandstone: stone('Smooth sandstone', 'smooth_sandstone', 'smooth_sandstone', { color: '#e0d6a7', group: 'Sandstone', pattern: 'smooth' }),
  red_sandstone: stone('Red sandstone', 'red_sandstone', 'red_sandstone', { wall: true, color: '#ba6621', group: 'Sandstone', pattern: 'sandstone' }),
  smooth_red_sandstone: stone('Smooth red sandstone', 'smooth_red_sandstone', 'smooth_red_sandstone', { color: '#bd6a23', group: 'Sandstone', pattern: 'smooth' }),

  // Quartz & purpur
  quartz: stone('Quartz', 'quartz_block', 'quartz', { color: '#ebe6df', group: 'Quartz & purpur', pattern: 'quartz' }),
  smooth_quartz: stone('Smooth quartz', 'smooth_quartz', 'smooth_quartz', { color: '#ede9e3', group: 'Quartz & purpur', pattern: 'quartz' }),
  purpur: stone('Purpur', 'purpur_block', 'purpur', { color: '#a97ba9', group: 'Quartz & purpur', pattern: 'purpur' }),

  // Prismarine
  prismarine: stone('Prismarine', 'prismarine', 'prismarine', { wall: true, color: '#639c93', group: 'Prismarine', pattern: 'prismarine' }),
  prismarine_bricks: stone('Prismarine bricks', 'prismarine_bricks', 'prismarine_brick', { color: '#63ac9e', group: 'Prismarine', pattern: 'stone_bricks' }),
  dark_prismarine: stone('Dark prismarine', 'dark_prismarine', 'dark_prismarine', { color: '#345c4c', group: 'Prismarine', pattern: 'prismarine' }),

  // Copper (4 oxidation levels)
  cut_copper: stone('Cut copper', 'cut_copper', 'cut_copper', { color: '#c06c50', group: 'Copper', pattern: 'copper' }),
  exposed_cut_copper: stone('Exposed cut copper', 'exposed_cut_copper', 'exposed_cut_copper', { color: '#9f7a65', group: 'Copper', pattern: 'copper' }),
  weathered_cut_copper: stone('Weathered cut copper', 'weathered_cut_copper', 'weathered_cut_copper', { color: '#6c9a6f', group: 'Copper', pattern: 'copper' }),
  oxidized_cut_copper: stone('Oxidized cut copper', 'oxidized_cut_copper', 'oxidized_cut_copper', { color: '#53a486', group: 'Copper', pattern: 'copper' }),
});

// ---- Logs and stripped logs (full only) ---------------------------------------
for (const [key, label, , logColor, strippedColor] of WOODS) {
  const id = logId(key);
  FAMILIES[id] = fullOnly(logName(key, label), id, logColor, 'Logs', 'log');
  FAMILIES['stripped_' + id] = fullOnly('Stripped ' + logName(key, label).toLowerCase(), 'stripped_' + id, strippedColor, 'Logs', 'log');
}

// ---- Terracotta (plain + 16), concrete (16), wool (16) ------------------------
FAMILIES.terracotta = fullOnly('Terracotta', 'terracotta', '#985e43', 'Terracotta', 'terracotta');
for (const [key, label, terra, concrete, wool] of DYES) {
  FAMILIES[key + '_terracotta'] = fullOnly(label + ' terracotta', key + '_terracotta', terra, 'Terracotta', 'terracotta');
  FAMILIES[key + '_concrete'] = fullOnly(label + ' concrete', key + '_concrete', concrete, 'Concrete', 'concrete');
  FAMILIES[key + '_wool'] = fullOnly(label + ' wool', key + '_wool', wool, 'Wool', 'wool');
}

// ---- Wood blocks (bark on all six sides) ------------------------------------------
for (const [key, label, , logColor, strippedColor] of WOODS) {
  if (key === 'bamboo') continue;
  const nether = key === 'crimson' || key === 'warped';
  const id = key + (nether ? '_hyphae' : '_wood');
  const nm = label + (nether ? ' hyphae' : ' wood');
  FAMILIES[id] = fullOnly(nm, id, logColor, 'Logs', 'log');
  FAMILIES['stripped_' + id] = fullOnly('Stripped ' + nm.toLowerCase(), 'stripped_' + id, strippedColor, 'Logs', 'log');
}
FAMILIES.bamboo_mosaic = { name: 'Bamboo mosaic', full: MC + 'bamboo_mosaic', slab: MC + 'bamboo_mosaic_slab', stairs: MC + 'bamboo_mosaic_stairs', wall: null, color: '#bfa944', group: 'Wood', pattern: 'planks' };
FAMILIES.bookshelf = fullOnly('Bookshelf', 'bookshelf', '#6b5430', 'Wood', 'planks');

// ---- Stone variants without their own slab/stairs ---------------------------------
const extraStone = [
  // key, name, color, group, pattern
  ['deepslate', 'Deepslate', '#505052', 'Dark stone', 'stone'],
  ['chiseled_deepslate', 'Chiseled deepslate', '#363637', 'Dark stone', 'chiseled'],
  ['cracked_deepslate_bricks', 'Cracked deepslate bricks', '#454546', 'Dark stone', 'stone_bricks'],
  ['cracked_deepslate_tiles', 'Cracked deepslate tiles', '#343435', 'Dark stone', 'tiles'],
  ['chiseled_polished_blackstone', 'Chiseled polished blackstone', '#353039', 'Dark stone', 'chiseled'],
  ['cracked_polished_blackstone_bricks', 'Cracked polished blackstone bricks', '#2c282e', 'Dark stone', 'stone_bricks'],
  ['chiseled_tuff', 'Chiseled tuff', '#5e645c', 'Dark stone', 'chiseled'],
  ['chiseled_tuff_bricks', 'Chiseled tuff bricks', '#62675f', 'Dark stone', 'chiseled'],
  ['chiseled_stone_bricks', 'Chiseled stone bricks', '#777777', 'Stone', 'chiseled'],
  ['cracked_stone_bricks', 'Cracked stone bricks', '#767676', 'Stone', 'stone_bricks'],
  ['smooth_basalt', 'Smooth basalt', '#48484e', 'Stone', 'smooth'],
  ['basalt', 'Basalt', '#4b4a4f', 'Stone', 'log'],
  ['polished_basalt', 'Polished basalt', '#646465', 'Stone', 'log'],
  ['calcite', 'Calcite', '#dfe0dc', 'Stone', 'stone'],
  ['dripstone_block', 'Dripstone block', '#86695a', 'Stone', 'sandstone'],
  ['obsidian', 'Obsidian', '#0f0b19', 'Stone', 'stone'],
  ['crying_obsidian', 'Crying obsidian', '#200a3c', 'Stone', 'stone'],
  ['end_stone', 'End stone', '#dbdea2', 'Stone', 'stone'],
  ['chiseled_nether_bricks', 'Chiseled nether bricks', '#2f171c', 'Bricks', 'chiseled'],
  ['cracked_nether_bricks', 'Cracked nether bricks', '#281417', 'Bricks', 'bricks'],
  ['chiseled_resin_bricks', 'Chiseled resin bricks', '#c86030', 'Bricks', 'chiseled'],
  ['resin_block', 'Block of resin', '#d96d1c', 'Bricks', 'smooth'],
  ['packed_mud', 'Packed mud', '#8e6b50', 'Bricks', 'terracotta'],
  ['chiseled_sandstone', 'Chiseled sandstone', '#d8ca9b', 'Sandstone', 'chiseled'],
  ['chiseled_red_sandstone', 'Chiseled red sandstone', '#b7601e', 'Sandstone', 'chiseled'],
  ['quartz_bricks', 'Quartz bricks', '#eae5dd', 'Quartz & purpur', 'stone_bricks'],
  ['chiseled_quartz_block', 'Chiseled quartz block', '#e7e2da', 'Quartz & purpur', 'chiseled'],
  ['quartz_pillar', 'Quartz pillar', '#ece6df', 'Quartz & purpur', 'log'],
  ['purpur_pillar', 'Purpur pillar', '#ab81ab', 'Quartz & purpur', 'log'],
];
for (const [key, name, color, group, pattern] of extraStone) FAMILIES[key] = fullOnly(name, key, color, group, pattern);
// Cut sandstone has a slab but no stairs.
FAMILIES.cut_sandstone = { name: 'Cut sandstone', full: MC + 'cut_sandstone', slab: MC + 'cut_sandstone_slab', stairs: null, wall: null, color: '#d9cb9e', group: 'Sandstone', pattern: 'sandstone' };
FAMILIES.cut_red_sandstone = { name: 'Cut red sandstone', full: MC + 'cut_red_sandstone', slab: MC + 'cut_red_sandstone_slab', stairs: null, wall: null, color: '#bd6a23', group: 'Sandstone', pattern: 'sandstone' };

// ---- Copper: waxed cut copper (keeps its colour), blocks, chiseled, grates --------
const COPPER = [['', '', '#c06c50'], ['exposed_', 'Exposed ', '#9f7a65'], ['weathered_', 'Weathered ', '#6c9a6f'], ['oxidized_', 'Oxidized ', '#53a486']];
for (const [pre, label, color] of COPPER) {
  const lc = label ? label.toLowerCase() : '';
  FAMILIES['waxed_' + pre + 'cut_copper'] = stone('Waxed ' + lc + 'cut copper', 'waxed_' + pre + 'cut_copper', 'waxed_' + pre + 'cut_copper', { color, group: 'Copper', pattern: 'copper' });
  const blockId = pre ? pre + 'copper' : 'copper_block';
  FAMILIES[blockId] = fullOnly((label || '') + (label ? 'copper' : 'Block of copper'), blockId, color, 'Copper', 'metal');
  FAMILIES['waxed_' + blockId] = fullOnly('Waxed ' + (label ? lc + 'copper' : 'block of copper'), 'waxed_' + blockId, color, 'Copper', 'metal');
  FAMILIES[blockId].door = MC + pre + 'copper_door'; FAMILIES[blockId].trapdoor = MC + pre + 'copper_trapdoor';
  FAMILIES['waxed_' + blockId].door = MC + 'waxed_' + pre + 'copper_door'; FAMILIES['waxed_' + blockId].trapdoor = MC + 'waxed_' + pre + 'copper_trapdoor';
  FAMILIES[pre + 'chiseled_copper'] = fullOnly((label || '') + (label ? 'chiseled copper' : 'Chiseled copper'), pre + 'chiseled_copper', color, 'Copper', 'chiseled');
  FAMILIES[pre + 'copper_grate'] = { ...fullOnly((label || '') + (label ? 'copper grate' : 'Copper grate'), pre + 'copper_grate', color, 'Copper', 'grate'), transparent: true };
}

// ---- Glass (full block + pane) ------------------------------------------------------
FAMILIES.glass = { name: 'Glass', full: MC + 'glass', slab: null, stairs: null, wall: null, pane: MC + 'glass_pane', color: '#c8dfe4', group: 'Glass', pattern: 'glass', transparent: true };
FAMILIES.tinted_glass = { ...fullOnly('Tinted glass', 'tinted_glass', '#2c2730', 'Glass', 'glass'), transparent: true };

// ---- Mineral / metal blocks ---------------------------------------------------------
for (const [key, name, color] of [
  ['iron_block', 'Block of iron', '#dcdcdc'], ['gold_block', 'Block of gold', '#f6d03d'], ['diamond_block', 'Block of diamond', '#62ede4'],
  ['emerald_block', 'Block of emerald', '#2ad764'], ['lapis_block', 'Block of lapis', '#1e43a8'], ['redstone_block', 'Block of redstone', '#af1805'],
  ['coal_block', 'Block of coal', '#101010'], ['netherite_block', 'Block of netherite', '#433f41'], ['amethyst_block', 'Block of amethyst', '#8562be'],
  ['raw_iron_block', 'Block of raw iron', '#a6886b'], ['raw_copper_block', 'Block of raw copper', '#9a6a4f'], ['raw_gold_block', 'Block of raw gold', '#dda92e'],
]) FAMILIES[key] = fullOnly(name, key, color, 'Mineral blocks', key.startsWith('raw_') || key === 'amethyst_block' ? 'stone' : 'metal');
FAMILIES.iron_block.door = MC + 'iron_door'; FAMILIES.iron_block.trapdoor = MC + 'iron_trapdoor';

// ---- Ores (stone/deepslate/netherrack with flecks) ----------------------------------
for (const [key, label, fleck] of [
  ['coal', 'Coal', '#2f2f2f'], ['iron', 'Iron', '#d8af93'], ['copper', 'Copper', '#e17c58'], ['gold', 'Gold', '#fcee4b'],
  ['redstone', 'Redstone', '#c80000'], ['emerald', 'Emerald', '#17dd62'], ['lapis', 'Lapis', '#1d47a6'], ['diamond', 'Diamond', '#5decf5'],
]) {
  FAMILIES[key + '_ore'] = { ...fullOnly(label + ' ore', key + '_ore', '#7e7e7e', 'Ores', 'ore'), color2: fleck };
  FAMILIES['deepslate_' + key + '_ore'] = { ...fullOnly('Deepslate ' + label.toLowerCase() + ' ore', 'deepslate_' + key + '_ore', '#4d4d50', 'Ores', 'ore'), color2: fleck };
}
FAMILIES.nether_gold_ore = { ...fullOnly('Nether gold ore', 'nether_gold_ore', '#622626', 'Ores', 'ore'), color2: '#fcee4b' };
FAMILIES.nether_quartz_ore = { ...fullOnly('Nether quartz ore', 'nether_quartz_ore', '#622626', 'Ores', 'ore'), color2: '#e8e2d8' };
FAMILIES.gilded_blackstone = { ...fullOnly('Gilded blackstone', 'gilded_blackstone', '#2a252c', 'Ores', 'ore'), color2: '#e8b23a' };
FAMILIES.ancient_debris = fullOnly('Ancient debris', 'ancient_debris', '#5e4840', 'Ores', 'log');

// ---- Natural blocks -----------------------------------------------------------------
for (const [key, name, color, pattern, extra] of [
  ['grass_block', 'Grass block', '#5d9a3a', 'grainy'], ['dirt', 'Dirt', '#866043', 'grainy'], ['coarse_dirt', 'Coarse dirt', '#77553b', 'grainy'],
  ['rooted_dirt', 'Rooted dirt', '#90684c', 'grainy'], ['podzol', 'Podzol', '#5b3f18', 'grainy'], ['mycelium', 'Mycelium', '#6f6265', 'grainy'],
  ['mud', 'Mud', '#3c393d', 'grainy'], ['clay', 'Clay', '#a0a6b3', 'smooth'], ['sand', 'Sand', '#dbcfa3', 'grainy'], ['red_sand', 'Red sand', '#be6621', 'grainy'],
  ['gravel', 'Gravel', '#83807e', 'cobble'], ['moss_block', 'Moss block', '#596d2d', 'wool'], ['pale_moss_block', 'Pale moss block', '#6b7066', 'wool'],
  ['snow_block', 'Snow block', '#f9fefe', 'grainy'], ['ice', 'Ice', '#91b7fd', 'glass', { transparent: true }], ['packed_ice', 'Packed ice', '#8db4fa', 'smooth'],
  ['blue_ice', 'Blue ice', '#74a8fd', 'smooth'], ['netherrack', 'Netherrack', '#622626', 'stone'], ['soul_sand', 'Soul sand', '#513e32', 'grainy'],
  ['soul_soil', 'Soul soil', '#4b3a2f', 'grainy'], ['magma_block', 'Magma block', '#8f3f1a', 'cobble'], ['glowstone', 'Glowstone', '#ac8654', 'cobble'],
  ['sea_lantern', 'Sea lantern', '#acc8be', 'quartz'], ['shroomlight', 'Shroomlight', '#f19347', 'wool'], ['nether_wart_block', 'Nether wart block', '#720b0b', 'wool'],
  ['warped_wart_block', 'Warped wart block', '#167b84', 'wool'], ['bone_block', 'Bone block', '#e2dec8', 'log'], ['hay_block', 'Hay bale', '#a88b0b', 'log'],
  ['honeycomb_block', 'Honeycomb block', '#e5941e', 'purpur'], ['dried_kelp_block', 'Dried kelp block', '#323b26', 'log'], ['sponge', 'Sponge', '#c3c04a', 'purpur'],
  ['pumpkin', 'Pumpkin', '#c27318', 'log'], ['melon', 'Melon', '#6f9118', 'log'], ['brown_mushroom_block', 'Brown mushroom block', '#956f51', 'terracotta'],
  ['red_mushroom_block', 'Red mushroom block', '#c82e2d', 'terracotta'], ['mushroom_stem', 'Mushroom stem', '#cbc4b9', 'terracotta'], ['target', 'Target', '#e2aa9e', 'concrete'],
]) FAMILIES[key] = { ...fullOnly(name, key, color, 'Natural', pattern), ...(extra || {}) };

// ---- Leaves (persistent so they never decay in the pasted build) -------------------
const LEAF_PROPS = { distance: '7', persistent: 'true', waterlogged: 'false' };
for (const [key, name, color] of [
  ['oak_leaves', 'Oak leaves', '#3f7f1f'], ['spruce_leaves', 'Spruce leaves', '#3d5e3d'], ['birch_leaves', 'Birch leaves', '#5c8a3a'],
  ['jungle_leaves', 'Jungle leaves', '#3f8a1c'], ['acacia_leaves', 'Acacia leaves', '#4a7a1e'], ['dark_oak_leaves', 'Dark oak leaves', '#3a6b1a'],
  ['mangrove_leaves', 'Mangrove leaves', '#4f7a22'], ['cherry_leaves', 'Cherry leaves', '#e8a8c4'], ['azalea_leaves', 'Azalea leaves', '#5a7a2a'],
  ['flowering_azalea_leaves', 'Flowering azalea leaves', '#6a7a4a'], ['pale_oak_leaves', 'Pale oak leaves', '#7f8a7b'],
]) FAMILIES[key] = { ...fullOnly(name, key, color, 'Leaves', 'leaves'), fullProps: LEAF_PROPS };

// ---- Dyed: stained glass (+pane), glazed terracotta, concrete powder ----------------
function mixHex(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (s) => Math.round(((pa >> s) & 255) * (1 - t) + ((pb >> s) & 255) * t);
  return '#' + ((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1);
}
for (const [key, label, , concrete, wool] of DYES) {
  FAMILIES[key + '_stained_glass'] = { name: label + ' stained glass', full: MC + key + '_stained_glass', slab: null, stairs: null, wall: null, pane: MC + key + '_stained_glass_pane', color: mixHex(wool, '#ffffff', 0.15), group: 'Glass', pattern: 'glass', transparent: true };
  FAMILIES[key + '_glazed_terracotta'] = { ...fullOnly(label + ' glazed terracotta', key + '_glazed_terracotta', wool, 'Glazed terracotta', 'glazed'), color2: mixHex(wool, key === 'white' ? '#4aa3c8' : '#ffffff', 0.45) };
  FAMILIES[key + '_concrete_powder'] = fullOnly(label + ' concrete powder', key + '_concrete_powder', mixHex(concrete, '#ffffff', 0.12), 'Concrete powder', 'grainy');
}

// Blocks with an `axis` blockstate (logs lie sideways when used as beams).
for (const [k, f] of Object.entries(FAMILIES)) {
  if (/_(log|wood|stem|hyphae)$/.test(k) || ['bamboo_block', 'stripped_bamboo_block', 'basalt', 'polished_basalt', 'quartz_pillar', 'purpur_pillar', 'bone_block', 'hay_block'].includes(k)) f.axis = true;
}

export const FAMILY_KEYS = Object.keys(FAMILIES);
export const GROUP_ORDER = ['Wood', 'Logs', 'Stone', 'Dark stone', 'Bricks', 'Sandstone', 'Quartz & purpur', 'Prismarine', 'Copper', 'Glass', 'Mineral blocks', 'Ores', 'Natural', 'Leaves', 'Terracotta', 'Glazed terracotta', 'Concrete', 'Concrete powder', 'Wool'];

/** Family keys usable for roofs: must have both slab and stairs. */
export function roofFamilies() {
  return FAMILY_KEYS.filter((k) => FAMILIES[k].slab && FAMILIES[k].stairs);
}

/** Families with a glass pane variant (windows). */
export function paneFamilies() {
  return FAMILY_KEYS.filter((k) => FAMILIES[k].pane);
}

/** Family keys usable for walls / pillars / segments (every family has a full block). */
export function fullFamilies() {
  return FAMILY_KEYS.slice();
}
