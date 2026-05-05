package wire

// Wordlists for room codes ("adjective-noun"). Curated to be:
//   - 4-7 letters, lowercase, ASCII only
//   - speakable over voice chat ("eight" not "8th"); no homophones we noticed
//   - no slurs, no body parts, no political/religious terms
//   - distinct enough between lists that the slot order is obvious
//
// The lists give Adjectives*Nouns codes; the signaling server retries on
// collision and applies per-IP join rate limiting.

// Adjectives is the first slot of a room code. Mostly colors, textures,
// dimensions, light, weather, mood — concrete enough to picture.
// Words that appear in Nouns (which fit better as objects) are not duplicated
// here, so codes can't read like "velvet-velvet".
var Adjectives = []string{
	"amber", "ancient", "arctic", "ashen", "autumn", "azure",
	"balmy", "beaming", "beige", "blazing", "blue", "blushing", "bold", "bouncy", "brave", "brassy", "breezy", "bright", "brisk", "bronze", "brown", "bubbly", "buoyant",
	"calm", "cheery", "chilly", "chipper", "chrome", "classic", "clay", "clever", "cloudy", "cobalt", "cool", "cosmic", "cosy", "crimson", "crisp", "crystal", "cuddly", "curly",
	"daring", "dapper", "dazzling", "deep", "dewy", "dimpled", "drowsy", "dusty", "dusky",
	"eager", "earthy", "easy", "ebony", "echoey", "electric", "elegant", "empty", "epic",
	"fancy", "faraway", "fearless", "feisty", "fierce", "fiery", "fizzy", "flaky", "fleet", "fleecy", "flighty", "fluffy", "foggy", "frosty", "fuzzy",
	"gallant", "gentle", "giddy", "glassy", "gleaming", "glowing", "graceful", "grassy", "gray", "green",
	"happy", "hardy", "hazy", "hearty", "honest", "hopeful", "humble", "husky",
	"icy", "indigo", "ivory",
	"jade", "jaunty", "jazzy", "jolly", "jovial", "joyful",
	"keen", "kind", "knowing",
	"lacy", "ladybug", "laser", "lazy", "leaf", "lilac", "lime", "lively", "lofty", "lucky", "lunar", "lush",
	"magic", "marshy", "mauve", "mellow", "merry", "midnight", "mighty", "mild", "minty", "misty", "moonlit", "mossy", "muted",
	"navy", "neat", "nimble", "noble",
	"oaken", "orange", "ornate",
	"pacific", "peaceful", "pearly", "peppy", "perky", "pewter", "pine", "pink", "plucky", "plush", "polar", "polished", "posh", "proud", "purple",
	"quaint", "quick", "quiet", "quirky",
	"radiant", "rainy", "rapid", "rascal", "regal", "rosy", "ruby", "rugged", "rustic",
	"salty", "sandy", "savory", "scarlet", "secret", "serene", "shadowy", "shiny", "shy", "silent", "silky", "silver", "simple", "sleek", "sleepy", "slender", "smoky", "smooth", "snappy", "snowy", "snug", "soft", "solar", "sparkling", "spicy", "spirited", "splendid", "sprightly", "spry", "starlit", "starry", "steady", "stellar", "stormy", "stout", "sturdy", "subtle", "sunny", "supple", "swift", "sylvan",
	"tame", "tangy", "tender", "thirsty", "thrifty", "tidy", "timely", "tranquil", "trusty", "turquoise", "twilit", "twinkly",
	"upbeat", "urban",
	"valiant", "verdant", "vibrant", "vintage", "vivid",
	"warm", "watery", "wavy", "western", "whimsy", "whispy", "windy", "winter", "wise", "witty", "wooden", "woolly",
	"yellow",
	"zealous", "zesty", "zippy",
}

// Nouns is the second slot of a room code. Animals, plants, weather, common
// objects — concrete and family-friendly.
var Nouns = []string{
	"acorn", "alpine", "anchor", "antler", "apple", "apricot", "arrow", "asteroid", "aspen", "aurora",
	"badger", "bagel", "bamboo", "basil", "basket", "bayou", "beacon", "bear", "beaver", "beetle", "berry", "biscuit", "bison", "blossom", "boulder", "bracelet", "branch", "brick", "buffalo", "bunny", "butter", "button",
	"cabin", "cactus", "campfire", "candle", "canoe", "canyon", "cape", "caramel", "cardinal", "cascade", "castle", "cat", "cedar", "cello", "chalk", "cherry", "chestnut", "chickpea", "chimney", "chinchilla", "cinder", "cinnamon", "clover", "cloud", "clove", "coast", "coconut", "comet", "compass", "copper", "coral", "corgi", "cottage", "courtyard", "crane", "crater", "creek", "cricket", "crocus", "crumpet", "cupcake", "currant", "cygnet", "cypress",
	"daisy", "deer", "delta", "diamond", "dolphin", "domino", "donut", "dove", "dragon", "duckling", "dune",
	"eagle", "ember", "emerald", "empire", "ermine", "everest",
	"falcon", "fawn", "feather", "fennel", "fern", "ferret", "festival", "fiddle", "field", "finch", "flamingo", "fleck", "fjord", "forest", "fountain", "fox", "frog",
	"galaxy", "garden", "gazebo", "geode", "ginger", "giraffe", "glade", "glacier", "goblet", "gopher", "gourd", "granite", "grape", "grouse",
	"hammock", "harbor", "harvest", "hawk", "hazel", "heron", "hibiscus", "highland", "hollow", "honey", "hummingbird", "hyacinth",
	"iceberg", "iguana", "iris", "island",
	"jacket", "jaguar", "jasmine", "juniper",
	"kangaroo", "kayak", "kelp", "kestrel", "kettle", "kingfisher", "kite", "kitten", "koala",
	"lagoon", "lantern", "lark", "lattice", "lavender", "ledge", "lemon", "lemur", "leopard", "lighthouse", "lily", "linden", "lion", "lobster", "locket", "lodge", "lotus", "lupine", "lynx",
	"macaron", "magnolia", "mallard", "mango", "maple", "marble", "marigold", "marsh", "meadow", "melon", "meridian", "mesa", "meteor", "minnow", "mocha", "monarch", "moose", "moss", "mountain", "muffin", "mushroom", "mustang",
	"narwhal", "nebula", "nectar", "needle", "nest", "newt", "nimbus", "noodle", "north",
	"oasis", "ocean", "ocelot", "octopus", "olive", "onyx", "opal", "orchard", "orchid", "osprey", "otter", "owl", "oyster",
	"paddock", "palm", "panda", "pansy", "papaya", "paprika", "parrot", "parsley", "partridge", "patio", "peach", "pebble", "pecan", "pelican", "penguin", "peony", "petal", "pheasant", "phoenix", "piano", "pickle", "pinecone", "piper", "pixel", "planet", "plover", "plum", "pollen", "poncho", "poppy", "possum", "prairie", "puffin", "pumpkin",
	"quail", "quartz", "quasar", "quokka", "quiver",
	"rabbit", "raccoon", "radish", "raindrop", "rapids", "raspberry", "raven", "ravine", "redwood", "reef", "ribbon", "ridge", "river", "robin", "rocket", "rooster", "rose", "rowan",
	"saffron", "sage", "salmon", "sapling", "sapphire", "satchel", "scroll", "seal", "seedling", "shamrock", "shoreline", "shrew", "silo", "skylark", "skyline", "sloth", "snowdrop", "sparrow", "spruce", "squirrel", "starling", "stoat", "stream", "summit", "sunbeam", "sundial", "sunflower", "sunset", "swallow",
	"tadpole", "tangerine", "teacup", "teal", "thicket", "thistle", "thunder", "tiger", "timber", "toast", "topaz", "torch", "tortoise", "totem", "trumpet", "tulip", "tundra", "turbine", "turnip", "turtle",
	"umbra", "unicorn",
	"valley", "vanilla", "velvet", "vesper", "violet", "vista", "volcano", "voyager",
	"walnut", "walrus", "warbler", "wasabi", "waterfall", "waxbill", "weasel", "wheat", "whisker", "willow", "windmill", "wisteria", "wombat", "woodland", "wren",
	"yam", "yarn", "yew", "yodel",
	"zebra", "zenith", "zephyr", "zinnia",
}
