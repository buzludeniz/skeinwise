// The words a recovery phrase is made of: 256 short, concrete English words, so each word carries 8 bits and 24 of
// them carry 192 bits. No two share their first four letters, and none is the start of another, so a word is easy to
// read back from paper and a typo rarely lands on a different word. The list is Skeinwise's own; changing it would
// make every phrase written down so far unreadable, so it never changes.

export const WORDS: readonly string[] = [
  'acorn', 'actor', 'agent', 'alarm', 'album', 'amber', 'anchor', 'ankle', 'apple', 'apron', 'arrow', 'atlas', 'autumn',
  'badge', 'bamboo', 'banjo', 'barn', 'basil', 'beach', 'bell', 'bench', 'berry', 'bike', 'birch', 'bison', 'blade',
  'bloom', 'board', 'bone', 'book', 'boot', 'bottle', 'bowl', 'brick', 'bridge', 'brook', 'brush', 'bucket', 'button',
  'cabin', 'cactus', 'camel', 'candle', 'canoe', 'cape', 'carrot', 'castle', 'cedar', 'chalk', 'cherry', 'chess',
  'cider', 'circle', 'clay', 'cliff', 'clock', 'cloud', 'clover', 'coast', 'cocoa', 'comet', 'copper', 'coral',
  'cotton', 'cove', 'crane', 'crayon', 'creek', 'crown', 'cube', 'daisy', 'delta', 'desert', 'dinner', 'door', 'dragon',
  'drum', 'duck', 'dune', 'eagle', 'echo', 'elbow', 'ember', 'engine', 'fabric', 'falcon', 'fern', 'ferry', 'field',
  'finch', 'flame', 'flute', 'forest', 'fossil', 'frame', 'frost', 'galaxy', 'garden', 'garlic', 'ginger', 'globe',
  'glove', 'goat', 'gold', 'grape', 'gravel', 'guitar', 'gull', 'hammer', 'harbor', 'harp', 'heron', 'hill', 'hive',
  'honey', 'hoof', 'hotel', 'igloo', 'iris', 'iron', 'island', 'ivory', 'jacket', 'jade', 'jaguar', 'jelly', 'jungle',
  'kayak', 'kettle', 'kiln', 'kite', 'koala', 'ladder', 'lagoon', 'lake', 'lava', 'leaf', 'lemon', 'lily', 'linen',
  'lion', 'lizard', 'llama', 'lotus', 'magnet', 'mango', 'maple', 'marble', 'meadow', 'melon', 'meteor', 'mint',
  'mirror', 'moon', 'moose', 'moss', 'moth', 'muffin', 'nectar', 'needle', 'nest', 'noodle', 'oasis', 'ocean', 'olive',
  'onion', 'opal', 'orange', 'orbit', 'orchid', 'otter', 'oyster', 'paddle', 'palm', 'panda', 'paper', 'parrot',
  'pasta', 'peach', 'pebble', 'pencil', 'pepper', 'piano', 'pillow', 'pine', 'planet', 'plum', 'pocket', 'quail',
  'quartz', 'quilt', 'rabbit', 'raft', 'rain', 'raven', 'reed', 'ribbon', 'ridge', 'river', 'robin', 'rocket', 'rose',
  'ruby', 'saddle', 'salmon', 'sand', 'scarf', 'seal', 'shell', 'silk', 'silver', 'sled', 'sloth', 'snail', 'spruce',
  'squid', 'stone', 'sugar', 'swan', 'table', 'thunder', 'tiger', 'timber', 'toast', 'tomato', 'topaz', 'torch',
  'tower', 'trail', 'tulip', 'tunnel', 'turnip', 'turtle', 'valley', 'velvet', 'violet', 'wagon', 'walnut', 'wave',
  'whale', 'wheat', 'willow', 'window', 'winter', 'wizard', 'wolf', 'wool', 'wren', 'yacht', 'yarn', 'yeast', 'yogurt',
  'yolk', 'zebra', 'zinc', 'zipper',
];
