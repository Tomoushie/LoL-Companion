/**
 * Glossaire éditorial de LoL BOT (V0.8).
 *
 * Ces définitions sont rédigées par l'application pour expliquer le vocabulaire
 * courant de League of Legends. Ce ne sont pas des données officielles Riot et
 * elles ne contiennent aucune statistique inventée : les chiffres réels restent
 * dans les vues Data Dragon / Riot / OP.GG.
 *
 * Les alias servent à la recherche (FR et EN) ; les `related` permettent de
 * naviguer d'un terme à l'autre.
 */

export type GlossaryCategoryId =
  | "fondamentaux"
  | "combat"
  | "carte"
  | "objets"
  | "runes"
  | "progression"
  | "meta";

export interface GlossaryCategory {
  readonly id: GlossaryCategoryId;
  readonly label: string;
  readonly description: string;
}

export interface GlossaryEntry {
  readonly id: string;
  readonly term: string;
  readonly aliases: readonly string[];
  readonly category: GlossaryCategoryId;
  readonly definition: string;
  readonly example?: string;
  readonly related?: readonly string[];
}

export const GLOSSARY_CATEGORIES: readonly GlossaryCategory[] = [
  {
    id: "fondamentaux",
    label: "Fondamentaux",
    description: "Vocabulaire de base : rôles, ressources et temps de jeu.",
  },
  {
    id: "combat",
    label: "Combat",
    description: "Affrontements, placement et vocabulaire des échanges.",
  },
  {
    id: "carte",
    label: "Carte & objectifs",
    description: "Vagues de sbires, vision, jungle et objectifs neutres.",
  },
  {
    id: "objets",
    label: "Objets & stats",
    description: "Statistiques, objets et pics de puissance.",
  },
  {
    id: "runes",
    label: "Runes",
    description: "Pages de runes, arbres et fragments.",
  },
  {
    id: "progression",
    label: "Rangs & progression",
    description: "Files de jeu, LP, classement et comportement en partie.",
  },
  {
    id: "meta",
    label: "Méta & analyse",
    description: "Vocabulaire des tier lists, des statistiques et des compositions.",
  },
];

export const GLOSSARY: readonly GlossaryEntry[] = [
  // --- Fondamentaux ---------------------------------------------------
  {
    id: "champion",
    term: "Champion",
    aliases: ["champ", "héros", "hero"],
    category: "fondamentaux",
    definition:
      "Personnage jouable de League of Legends, avec ses sorts, ses statistiques et son rôle. Chaque partie réunit deux équipes de cinq champions.",
    related: ["role", "lane", "summoner"],
  },
  {
    id: "summoner",
    term: "Invocateur",
    aliases: ["summoner", "joueur", "compte"],
    category: "fondamentaux",
    definition:
      "Compte de joueur sur lequel on possède des champions, des runes et un classement. Le Riot ID (nom#tag) identifie un invocateur.",
    related: ["riot-id", "rank"],
  },
  {
    id: "riot-id",
    term: "Riot ID",
    aliases: ["pseudo", "game name", "tagline", "tag"],
    category: "fondamentaux",
    definition:
      "Identifiant public d'un compte Riot, composé d'un nom et d'un tag après le dièse (par exemple Nom#EUW). Il remplace l'ancien nom d'invocateur.",
    related: ["summoner"],
  },
  {
    id: "lane",
    term: "Voie",
    aliases: ["lane", "ligne"],
    category: "fondamentaux",
    definition:
      "Couloir de la carte où les sbires avancent : top, mid ou bot. La jungle n'est pas une voie mais un rôle à part.",
    related: ["top", "mid", "adc", "support", "jungle"],
  },
  {
    id: "role",
    term: "Rôle",
    aliases: ["role", "position"],
    category: "fondamentaux",
    definition:
      "Place attribuée à un joueur dans son équipe : top, jungle, mid, ADC ou support. Le rôle détermine les responsabilités et souvent la voie.",
    related: ["top", "jungle", "mid", "adc", "support"],
  },
  {
    id: "top",
    term: "Top",
    aliases: ["toplane", "voie du haut", "top lane"],
    category: "fondamentaux",
    definition:
      "Voie du haut, souvent occupée par un combattant ou un tank qui tient la durée et crée de l'espace pour son équipe.",
    related: ["lane", "split-push"],
  },
  {
    id: "jungle",
    term: "Jungle",
    aliases: ["jungler", "junglage"],
    category: "fondamentaux",
    definition:
      "Rôle qui farm les camps de monstres entre les voies, sécurise les objectifs et crée des opportunités avec des ganks.",
    related: ["camp", "gank", "smite", "pathing"],
  },
  {
    id: "mid",
    term: "Mid",
    aliases: ["midlane", "voie du milieu", "middle"],
    category: "fondamentaux",
    definition:
      "Voie centrale, souvent occupée par un mage ou un assassin qui peut se déplacer rapidement vers les objectifs et les autres voies.",
    related: ["lane", "roam"],
  },
  {
    id: "adc",
    term: "ADC",
    aliases: ["attack damage carry", "bot lane", "botlaner", "tireur"],
    category: "fondamentaux",
    definition:
      "Rôle de la voie du bas centré sur les dégâts physiques à distance. L'ADC farm beaucoup et devient souvent la principale source de dégâts en fin de partie.",
    related: ["lane", "carry", "support"],
  },
  {
    id: "support",
    term: "Support",
    aliases: ["supp", "soutien"],
    category: "fondamentaux",
    definition:
      "Rôle qui accompagne l'ADC, apporte de la vision, du contrôle et de la protection, souvent sans prendre l'or des sbires.",
    related: ["vision", "peel", "engage"],
  },
  {
    id: "farm",
    term: "Farm",
    aliases: ["farming", "farmer", "creep score"],
    category: "fondamentaux",
    definition:
      "Action de tuer les sbires et les monstres pour gagner de l'or et de l'expérience. Le farm se mesure souvent en CS et en CS par minute.",
    related: ["cs", "gold", "wave"],
  },
  {
    id: "cs",
    term: "CS",
    aliases: ["creep score", "last hit", "last hits", "sbires tués"],
    category: "fondamentaux",
    definition:
      "Nombre de sbires et de monstres tués par un joueur. Le CS (creep score) mesure le farm ; le CS par minute permet de comparer des parties de durées différentes.",
    related: ["farm", "gold"],
  },
  {
    id: "gold",
    term: "Or",
    aliases: ["gold", "money"],
    category: "fondamentaux",
    definition:
      "Monnaie gagnée en tuant des sbires, des monstres, des champions ou des structures, et dépensée pour acheter des objets.",
    related: ["cs", "item-spike"],
  },
  {
    id: "xp",
    term: "Expérience",
    aliases: ["xp", "exp", "niveau"],
    category: "fondamentaux",
    definition:
      "Ressource qui fait monter le niveau du champion et débloque les sorts. L'expérience vient principalement des sbires et des monstres proches.",
    related: ["level", "power-spike"],
  },
  {
    id: "level",
    term: "Niveau",
    aliases: ["level", "lvl"],
    category: "fondamentaux",
    definition:
      "Progression d'un champion dans une partie (jusqu'au niveau 18). Chaque niveau améliore les statistiques et permet de monter les sorts.",
    related: ["xp", "power-spike"],
  },
  {
    id: "kda",
    term: "KDA",
    aliases: ["kda ratio", "ratio kda", "kills deaths assists"],
    category: "fondamentaux",
    definition:
      "Ratio (éliminations + assistances) / morts. Le KDA résume l'efficacité d'un joueur, mais ne dit rien à lui seul de sa contribution aux objectifs.",
    example: "2 éliminations, 1 mort et 5 assistances donnent un KDA de 7.",
    related: ["kill-participation", "win-rate"],
  },
  {
    id: "kill-participation",
    term: "Participation aux éliminations",
    aliases: ["kill participation", "kp", "participation"],
    category: "fondamentaux",
    definition:
      "Part des éliminations de l'équipe auxquelles un joueur a participé. C'est un bon indicateur d'implication dans les combats et les objectifs.",
    related: ["kda", "teamfight"],
  },
  {
    id: "power-spike",
    term: "Pic de puissance",
    aliases: ["power spike", "pic de puissance", "spike"],
    category: "fondamentaux",
    definition:
      "Moment où un champion devient nettement plus fort : un niveau clé, un objet terminé ou une amélioration de sort. Autour de ce moment, il faut chercher à profiter de l'avantage.",
    related: ["item-spike", "scaling"],
  },
  {
    id: "scaling",
    term: "Scaling",
    aliases: ["montée en puissance", "échelle"],
    category: "fondamentaux",
    definition:
      "Capacité d'un champion à devenir plus fort avec le temps, les niveaux et les objets. Un champion à fort scaling est souvent plus utile en fin de partie.",
    related: ["early-game", "late-game", "power-spike"],
  },
  {
    id: "early-game",
    term: "Early game",
    aliases: ["début de partie", "early"],
    category: "fondamentaux",
    definition:
      "Première phase d'une partie, où les niveaux et les objets sont encore limités. Les champions forts tôt cherchent à prendre de l'avance avant que leurs adversaires ne montent en puissance.",
    related: ["mid-game", "late-game", "scaling"],
  },
  {
    id: "mid-game",
    term: "Mid game",
    aliases: ["milieu de partie", "midgame"],
    category: "fondamentaux",
    definition:
      "Phase intermédiaire, souvent autour des premiers combats d'équipe et des objectifs majeurs. Les rotations et la vision y prennent une place importante.",
    related: ["early-game", "late-game", "objective"],
  },
  {
    id: "late-game",
    term: "Late game",
    aliases: ["fin de partie", "late", "late game"],
    category: "fondamentaux",
    definition:
      "Dernière phase, où les champions ont presque tous leurs objets. Une erreur de placement peut décider de la partie ; les objectifs majeurs et les combats d'équipe sont décisifs.",
    related: ["early-game", "mid-game", "teamfight"],
  },

  // --- Combat ---------------------------------------------------------
  {
    id: "poke",
    term: "Poke",
    aliases: ["harcèlement à distance", "poking"],
    category: "combat",
    definition:
      "Consiste à infliger des dégâts à distance, souvent avec des sorts, sans s'engager dans un échange long. Le poke use l'adversaire avant un objectif ou un combat.",
    related: ["harass", "trade"],
  },
  {
    id: "harass",
    term: "Harass",
    aliases: ["harceler", "harcèlement"],
    category: "combat",
    definition:
      "Infliger régulièrement de petits dégâts en lane pour user l'adversaire et l'empêcher de farm tranquillement. À distinguer d'un all-in.",
    related: ["poke", "trade", "all-in"],
  },
  {
    id: "trade",
    term: "Trade",
    aliases: ["échange", "échange de coups"],
    category: "combat",
    definition:
      "Échange de dégâts entre deux adversaires en lane. Un bon trade gagne plus de PV ou de pression que l'adversaire, souvent en profitant d'un ou plusieurs sorts.",
    related: ["harass", "all-in", "cooldown"],
  },
  {
    id: "all-in",
    term: "All-in",
    aliases: ["tout pour le tout", "engagement total"],
    category: "combat",
    definition:
      "Engagement dans lequel un joueur utilise toutes ses ressources pour tuer l'adversaire, sans prévoir de repli. Un all-in raté peut coûter cher.",
    related: ["engage", "burst", "trade"],
  },
  {
    id: "engage",
    term: "Engage",
    aliases: ["engagement", "initiation", "initier"],
    category: "combat",
    definition:
      "Action de déclencher un combat, souvent avec un contrôle de foule ou un déplacement. Un bon engage crée un avantage numérique ou positionnel.",
    related: ["disengage", "cc", "teamfight"],
  },
  {
    id: "disengage",
    term: "Disengage",
    aliases: ["désengagement", "désengager", "désengage"],
    category: "combat",
    definition:
      "Action de sortir d'un combat ou d'empêcher l'adversaire de l'imposer, avec du contrôle, des ralentissements ou des déplacements. Le disengage protège une équipe qui ne veut pas se battre.",
    related: ["engage", "peel", "kite"],
  },
  {
    id: "peel",
    term: "Peel",
    aliases: ["protection", "protéger", "peeling"],
    category: "combat",
    definition:
      "Protéger un coéquipier fragile en repoussant, ralentissant ou contrôlant les adversaires qui l'attaquent. C'est une tâche classique du support et du tank.",
    related: ["support", "frontline", "disengage"],
  },
  {
    id: "frontline",
    term: "Frontline",
    aliases: ["première ligne", "front line"],
    category: "combat",
    definition:
      "Champions qui se placent devant l'équipe pour absorber les dégâts et ouvrir le chemin. Ils protègent les carrys et créent de l'espace.",
    related: ["backline", "peel", "engage"],
  },
  {
    id: "backline",
    term: "Backline",
    aliases: ["arrière-garde", "back line", "seconde ligne"],
    category: "combat",
    definition:
      "Champions fragiles qui restent derrière la frontline pour infliger des dégâts à distance. Leur placement est crucial dans les combats d'équipe.",
    related: ["frontline", "carry", "peel"],
  },
  {
    id: "carry",
    term: "Carry",
    aliases: ["porteur", "carry", "hypercarry"],
    category: "combat",
    definition:
      "Champion qui, une fois assez fort, peut porter son équipe par ses dégâts ou son impact. Les carrys ont souvent besoin de protection et de ressources.",
    related: ["adc", "frontline", "scaling"],
  },
  {
    id: "cc",
    term: "Contrôle de foule",
    aliases: ["cc", "crowd control", "contrôle"],
    category: "combat",
    definition:
      "Effet qui limite les actions d'un champion : étourdissement, ralentissement, immobilisation, silence, projection, etc. Le CC permet d'engager, de protéger ou de sécuriser une élimination.",
    related: ["engage", "peel", "tenacity"],
  },
  {
    id: "kite",
    term: "Kite",
    aliases: ["kiting", "orb walk", "orbwalk"],
    category: "combat",
    definition:
      "Attaquer tout en reculant pour garder la distance avec un adversaire qui veut s'approcher. Le kite combine déplacements et attaques à distance.",
    related: ["poke", "disengage", "adc"],
  },
  {
    id: "burst",
    term: "Burst",
    aliases: ["dégâts burst", "explosif", "one-shot"],
    category: "combat",
    definition:
      "Dégâts très rapides infligés en peu de temps, souvent pour tuer une cible avant qu'elle ne réagisse. Les assassins et certains mages reposent sur le burst.",
    related: ["assassin", "all-in", "cc"],
  },
  {
    id: "dps",
    term: "DPS",
    aliases: ["damage per second", "dégâts par seconde", "dégâts continus"],
    category: "combat",
    definition:
      "Dégâts infligés de façon continue dans le temps, par opposition au burst. Un champion à DPS élevé est efficace sur les cibles résistantes et les objectifs.",
    related: ["burst", "carry", "adc"],
  },
  {
    id: "sustain",
    term: "Sustain",
    aliases: ["soutien de vie", "soin", "régénération", "sustain"],
    category: "combat",
    definition:
      "Capacité à restaurer ou préserver ses points de vie et son mana pour rester en lane. Le sustain peut venir d'un soin, d'un vol de vie ou d'un bouclier.",
    related: ["lifesteal", "omnivamp", "harass"],
  },
  {
    id: "bait",
    term: "Bait",
    aliases: ["appâter", "embuscade", "piège"],
    category: "combat",
    definition:
      "Attirer volontairement un adversaire dans une situation dangereuse, par exemple près d'un coéquipier caché. Le bait exploite la confiance ou la précipitation de l'adversaire.",
    related: ["gank", "vision", "tilt"],
  },
  {
    id: "focus",
    term: "Focus",
    aliases: ["focus fire", "cibler", "concentrer les dégâts"],
    category: "combat",
    definition:
      "Concentrer les dégâts de l'équipe sur une même cible pour l'éliminer rapidement. Le focus est essentiel pour transformer un avantage en élimination.",
    related: ["pick", "teamfight", "cc"],
  },
  {
    id: "dive",
    term: "Dive",
    aliases: ["tower dive", "plongée", "dive sous tour"],
    category: "combat",
    definition:
      "Attaquer un adversaire sous sa tourelle, généralement avec un avantage numérique ou un moyen d'absorber les tirs. Un dive réussi fait perdre beaucoup de ressources à l'adversaire.",
    related: ["gank", "tower", "engage"],
  },
  {
    id: "gank",
    term: "Gank",
    aliases: ["ganker", "ganks", "embuscade"],
    category: "combat",
    definition:
      "Attaque surprise d'une voie par le jungler ou un autre joueur, pour prendre l'adversaire en infériorité numérique. Un gank réussi crée de l'avance ou libère la voie.",
    related: ["jungle", "counter-gank", "roam"],
  },
  {
    id: "counter-gank",
    term: "Counter-gank",
    aliases: ["contre-gank", "contre gank"],
    category: "combat",
    definition:
      "Intervenir sur un gank adverse pour retourner la situation, souvent en arrivant en même temps ou juste après le jungler ennemi. Le counter-gank est très fort quand la vision révèle l'approche adverse.",
    related: ["gank", "vision", "jungle"],
  },
  {
    id: "roam",
    term: "Roam",
    aliases: ["roaming", "déplacement", "roam"],
    category: "combat",
    definition:
      "Quitter sa voie pour aller aider une autre voie ou sécuriser un objectif. Le roam est souvent rentable quand la vague est poussée et que l'adversaire ne peut pas suivre.",
    related: ["rotate", "gank", "wave"],
  },
  {
    id: "rotate",
    term: "Rotation",
    aliases: ["rotate", "rotations", "rotation"],
    category: "combat",
    definition:
      "Déplacement coordonné d'un ou plusieurs joueurs vers une zone d'objectif ou un combat. Une bonne rotation arrive avant l'adversaire et crée un avantage local.",
    related: ["roam", "objective", "mid-game"],
  },
  {
    id: "pick",
    term: "Pick",
    aliases: ["catch", "attraper", "élimination isolée"],
    category: "combat",
    definition:
      "Éliminer une cible isolée avant un combat ou un objectif, souvent avec du contrôle ou de la vision. Un pick transforme une situation neutre en supériorité numérique.",
    related: ["vision", "focus", "cc"],
  },
  {
    id: "teamfight",
    term: "Combat d'équipe",
    aliases: ["teamfight", "team fight", "combat 5v5"],
    category: "combat",
    definition:
      "Affrontement entre les deux équipes, souvent autour d'un objectif. Le placement, l'engage, le focus et la protection des carrys y déterminent le résultat.",
    related: ["engage", "frontline", "focus"],
  },
  {
    id: "skirmish",
    term: "Skirmish",
    aliases: ["escarmouche", "combat réduit"],
    category: "combat",
    definition:
      "Combat de faible ampleur, souvent 2v2 ou 3v3, autour d'une vague ou d'un camp. Les skirmishes décident souvent du contrôle de la jungle et des objectifs.",
    related: ["teamfight", "jungle", "objective"],
  },

  // --- Carte & objectifs ---------------------------------------------
  {
    id: "wave",
    term: "Vague de sbires",
    aliases: ["wave", "vague", "minion wave"],
    category: "carte",
    definition:
      "Groupe de sbires qui avancent ensemble le long d'une voie. Gérer les vagues permet de farm, de créer de la pression ou de revenir en sécurité.",
    related: ["freeze", "slow-push", "fast-push"],
  },
  {
    id: "freeze",
    term: "Freeze",
    aliases: ["gel de vague", "freezer", "gel"],
    category: "carte",
    definition:
      "Garder une vague près de sa propre tourelle en contrôlant les derniers coups, pour farm en sécurité et priver l'adversaire de farm. Le freeze demande un bon équilibre de sbires.",
    related: ["wave", "slow-push", "cs"],
  },
  {
    id: "slow-push",
    term: "Slow push",
    aliases: ["poussée lente", "slowpush"],
    category: "carte",
    definition:
      "Laisser une vague grossir progressivement pour qu'elle pousse seule et crée une pression durable. Le slow push prépare souvent un dive, un roam ou une prise d'objectif.",
    related: ["wave", "freeze", "fast-push"],
  },
  {
    id: "fast-push",
    term: "Fast push",
    aliases: ["poussée rapide", "push rapide", "hard push"],
    category: "carte",
    definition:
      "Tuer rapidement les sbires pour envoyer la vague sous la tourelle adverse et se libérer du temps. Le fast push permet de recall, de roam ou de prendre un objectif.",
    related: ["wave", "slow-push", "recall"],
  },
  {
    id: "crash",
    term: "Crash",
    aliases: ["crash de vague", "vague sous tourelle"],
    category: "carte",
    definition:
      "Faire arriver une vague sous la tourelle adverse, souvent pour forcer l'adversaire à la nettoyer ou pour préparer un dive/rappel. Le crash donne une fenêtre de temps au pousseur.",
    related: ["wave", "dive", "recall"],
  },
  {
    id: "recall",
    term: "Recall",
    aliases: ["back", "retour à la base", "rappel"],
    category: "carte",
    definition:
      "Retourner à la base pour acheter des objets et récupérer des PV/mana. Un recall bien préparé (vague poussée) minimise les pertes de farm.",
    related: ["back-timing", "wave", "item-spike"],
  },
  {
    id: "back-timing",
    term: "Timing de retour",
    aliases: ["back timing", "timing de recall", "reset"],
    category: "carte",
    definition:
      "Moment choisi pour revenir à la base, idéalement après avoir poussé une vague ou avant un objectif. Un mauvais timing fait perdre des sbires et de la pression.",
    related: ["recall", "wave", "objective"],
  },
  {
    id: "vision",
    term: "Vision",
    aliases: ["contrôle de vision", "wars", "vision score"],
    category: "carte",
    definition:
      "Information obtenue en plaçant des balises et en détruisant celles de l'adversaire. La vision révèle les déplacements ennemis et sécurise les objectifs.",
    related: ["ward", "control-ward", "oracle-lens"],
  },
  {
    id: "ward",
    term: "Balise",
    aliases: ["ward", "stealth ward", "balise furtive"],
    category: "carte",
    definition:
      "Objet placé sur la carte pour révéler une zone. Les balises furtives sont limitées en nombre et peuvent être révélées par un balayage.",
    related: ["vision", "control-ward", "oracle-lens"],
  },
  {
    id: "control-ward",
    term: "Balise de contrôle",
    aliases: ["control ward", "pink ward", "balise rose"],
    category: "carte",
    definition:
      "Balise visible qui révèle et désactive les balises adverses dans sa portée. Elle est limitée à une par joueur sur la carte et se révèle utile pour sécuriser une zone.",
    related: ["vision", "ward", "oracle-lens"],
  },
  {
    id: "oracle-lens",
    term: "Lentille d'oracle",
    aliases: ["oracle lens", "balayage", "sweeper"],
    category: "carte",
    definition:
      "Objet de trinket qui révèle et détruit les balises adverses autour de soi. Le balayage prépare une embuscade ou nettoie la vision avant un objectif.",
    related: ["vision", "ward", "control-ward"],
  },
  {
    id: "objective",
    term: "Objectif",
    aliases: ["objectif", "objectifs", "neutral objective"],
    category: "carte",
    definition:
      "Élément neutre ou structurant qui donne un avantage à l'équipe qui le sécurise : dragon, Baron, Héraut, tours, etc. Jouer autour des objectifs est central au macro-game.",
    related: ["dragon", "baron", "tower"],
  },
  {
    id: "dragon",
    term: "Dragon",
    aliases: ["dragons", "drake"],
    category: "carte",
    definition:
      "Monstre neutre de la rivière qui donne un bonus cumulable à son équipe. Les dragons élémentaires mènent à une âme lorsque l'équipe en a tué quatre.",
    related: ["soul", "elder", "objective"],
  },
  {
    id: "soul",
    term: "Âme du dragon",
    aliases: ["dragon soul", "âme", "soul"],
    category: "carte",
    definition:
      "Bonus accordé à l'équipe qui tue son quatrième dragon. L'âme est puissante et reste active pour le reste de la partie ; l'Elder dragon apparaît ensuite.",
    related: ["dragon", "elder"],
  },
  {
    id: "elder",
    term: "Elder Dragon",
    aliases: ["elder", "dragon ancêtre", "ancien dragon"],
    category: "carte",
    definition:
      "Dragon qui apparaît après l'âme et donne un bonus très fort, notamment des dégâts capables d'exécuter les cibles affaiblies. Il est souvent décisif en fin de partie.",
    related: ["dragon", "soul", "objective"],
  },
  {
    id: "baron",
    term: "Baron Nashor",
    aliases: ["baron", "nashor", "nash"],
    category: "carte",
    definition:
      "Monstre neutre majeur de la fosse du Baron. Le tuer donne un bonus qui améliore les sbires alliés et facilite la prise de tours et d'inhibiteurs.",
    related: ["objective", "herald", "late-game"],
  },
  {
    id: "herald",
    term: "Héraut de la faille",
    aliases: ["rift herald", "herald", "héraut"],
    category: "carte",
    definition:
      "Monstre neutre qui, une fois invoqué, charge les structures adverses et inflige d'importants dégâts. Il aide à convertir une avance en tours détruits.",
    related: ["baron", "objective", "tower"],
  },
  {
    id: "voidgrubs",
    term: "Voidgrubs",
    aliases: ["void grubs", "vers du néant", "grubs"],
    category: "carte",
    definition:
      "Petits monstres neutres qui, lorsqu'ils sont tués, donnent un bonus d'endommagement des structures. Ils se concentrent sur la partie haute de la carte.",
    related: ["objective", "tower", "herald"],
  },
  {
    id: "scuttle",
    term: "Scuttle",
    aliases: ["scuttle crab", "crabe", "scuttle"],
    category: "carte",
    definition:
      "Crabe neutre de la rivière qui donne de l'expérience, de l'or et une zone de vision une fois tué. Les junglers le prennent souvent avant les objectifs.",
    related: ["jungle", "vision", "objective"],
  },
  {
    id: "camp",
    term: "Camp de jungle",
    aliases: ["camp", "camps", "monstres"],
    category: "carte",
    definition:
      "Groupe de monstres de la jungle qui réapparaît après un délai. Nettoyer les camps donne de l'or, de l'expérience et des buffs.",
    related: ["jungle", "buff", "pathing"],
  },
  {
    id: "buff",
    term: "Buff",
    aliases: ["buff", "amélioration", "bonus"],
    category: "carte",
    definition:
      "Amélioration temporaire accordée par un monstre, un sort ou un objectif. Les buffs de jungle bleu et rouge sont des exemples classiques.",
    related: ["camp", "objective"],
  },
  {
    id: "invade",
    term: "Invade",
    aliases: ["invasion", "envahir", "invades"],
    category: "carte",
    definition:
      "Entrer dans la jungle adverse pour voler un camp, poser de la vision ou tuer le jungler. Un invade réussi crée un retard chez l'adversaire.",
    related: ["jungle", "camp", "vision"],
  },
  {
    id: "pathing",
    term: "Pathing",
    aliases: ["route de jungle", "chemin", "clear"],
    category: "carte",
    definition:
      "Ordre dans lequel le jungler nettoye ses camps et se déplace sur la carte. Un bon pathing aligne les camps avec les objectifs et les opportunités de gank.",
    related: ["jungle", "camp", "gank"],
  },
  {
    id: "smite",
    term: "Châtiment",
    aliases: ["smite", "châtier"],
    category: "carte",
    definition:
      "Sort d'invocateur utilisé principalement par le jungler pour infliger des dégâts aux monstres et sécuriser un objectif. Il peut écraser un monstre neutre à partir de certains niveaux.",
    related: ["jungle", "objective", "dragon"],
  },
  {
    id: "split-push",
    term: "Split push",
    aliases: ["splitpush", "poussée latérale", "split"],
    category: "carte",
    definition:
      "Pousser une voie latérale seul pendant que l'équipe crée de la pression ailleurs. Le split push force l'adversaire à choisir entre défendre sa base et suivre le groupe.",
    related: ["top", "wave", "objective"],
  },
  {
    id: "teleport",
    term: "Téléportation",
    aliases: ["tp", "teleport", "téléport"],
    category: "carte",
    definition:
      "Sort d'invocateur qui permet de rejoindre une balise alliée ou un sbire après un temps de canalisation. Très utilisé pour le contrôle de carte et les rotations.",
    related: ["split-push", "objective"],
  },
  {
    id: "flash",
    term: "Flash",
    aliases: ["saut", "flash", "éclair"],
    category: "carte",
    definition:
      "Sort d'invocateur qui téléporte le champion sur une courte distance. Il sert à engager, à fuir ou à esquiver un sort et possède un long temps de rechargement.",
    related: ["summoner-spell", "engage"],
  },
  {
    id: "summoner-spell",
    term: "Sort d'invocateur",
    aliases: ["summoner spell", "sorts d'invocateur", "invocateur"],
    category: "carte",
    definition:
      "Sort choisi avant la partie en plus des sorts du champion (Flash, Téléportation, Châtiment, etc.). Il apporte un outil décisif avec un temps de rechargement propre.",
    related: ["flash", "teleport", "smite"],
  },
  {
    id: "tower",
    term: "Tourelle",
    aliases: ["tour", "tower", "turret"],
    category: "carte",
    definition:
      "Structure défensive qui attaque les sbires et les champions ennemis. Détruire les tourelles ouvre la carte et donne de la pression sur la base adverse.",
    related: ["objective", "dive", "split-push"],
  },

  // --- Objets & stats -------------------------------------------------
  {
    id: "ad",
    term: "AD",
    aliases: ["attack damage", "dégâts d'attaque", "dégâts physiques"],
    category: "objets",
    definition:
      "Dégâts d'attaque : statistique qui augmente les dégâts des attaques de base et de nombreux sorts. Les objets AD sont souvent portés par les combattants et les ADC.",
    related: ["ap", "crit", "lethality"],
  },
  {
    id: "ap",
    term: "AP",
    aliases: ["ability power", "puissance des sorts"],
    category: "objets",
    definition:
      "Puissance des sorts : statistique qui augmente les dégâts de nombreux sorts. Les mages et certains combattants magiques s'appuient sur l'AP.",
    related: ["ad", "magic-pen", "burst"],
  },
  {
    id: "armor",
    term: "Armure",
    aliases: ["armor", "armure", "défense physique"],
    category: "objets",
    definition:
      "Statistique défensive qui réduit les dégâts physiques subis. L'armure est efficace contre les attaques de base et les sorts physiques.",
    related: ["mr", "lethality", "armor-pen"],
  },
  {
    id: "mr",
    term: "Résistance magique",
    aliases: ["mr", "magic resist", "resistance magique", "résistance magique"],
    category: "objets",
    definition:
      "Statistique défensive qui réduit les dégâts magiques subis. La résistance magique protège contre les mages et les sorts magiques.",
    related: ["armor", "magic-pen", "tenacity"],
  },
  {
    id: "hp",
    term: "PV",
    aliases: ["hp", "health", "points de vie", "vie"],
    category: "objets",
    definition:
      "Points de vie : réserve de vie d'un champion. Les objets de PV augmentent la survie, mais l'efficacité dépend aussi des résistances.",
    related: ["armor", "mr", "sustain"],
  },
  {
    id: "mana",
    term: "Mana",
    aliases: ["mana", "ressource", "énergie"],
    category: "objets",
    definition:
      "Ressource consommée par les sorts de la plupart des champions. Certains champions utilisent une autre ressource (énergie, fureur, etc.).",
    related: ["ap", "sustain"],
  },
  {
    id: "haste",
    term: "Hâte",
    aliases: ["ability haste", "haste", "cdr", "réduction de recharge"],
    category: "objets",
    definition:
      "Statistique qui réduit le temps de recharge des sorts. Plus la hâte est élevée, plus les sorts reviennent souvent, avec des rendements décroissants.",
    related: ["cooldown", "ap", "trade"],
  },
  {
    id: "crit",
    term: "Coups critiques",
    aliases: ["crit", "critical strike", "critique"],
    category: "objets",
    definition:
      "Chance qu'une attaque de base inflige des dégâts critiques, généralement multipliés. Le taux de coups critiques est plafonné et très courant chez les ADC.",
    related: ["ad", "dps", "adc"],
  },
  {
    id: "lethality",
    term: "Létalité",
    aliases: ["lethality", "pénétration physique plate"],
    category: "objets",
    definition:
      "Statistique qui pénètre une partie de l'armure adverse de façon fixe. La létalité est particulièrement efficace contre les cibles peu blindées.",
    related: ["armor-pen", "ad", "armor"],
  },
  {
    id: "armor-pen",
    term: "Pénétration d'armure",
    aliases: ["armor pen", "armor penetration", "pénétration physique"],
    category: "objets",
    definition:
      "Statistique qui réduit l'armure effective de la cible, en pourcentage ou en valeur fixe. La pénétration en pourcentage est souvent plus forte contre les tanks.",
    related: ["lethality", "armor", "ad"],
  },
  {
    id: "magic-pen",
    term: "Pénétration magique",
    aliases: ["magic pen", "magic penetration", "pénétration magique"],
    category: "objets",
    definition:
      "Statistique qui réduit la résistance magique effective de la cible. Elle existe en valeur fixe ou en pourcentage et aide les dégâts magiques à passer.",
    related: ["mr", "ap", "burst"],
  },
  {
    id: "omnivamp",
    term: "Omnivamp",
    aliases: ["omnivamp", "vol de vie global"],
    category: "objets",
    definition:
      "Soigne le champion d'un pourcentage des dégâts infligés, qu'ils soient physiques, magiques ou purs. L'omnivamp s'applique aussi aux dégâts de zone.",
    related: ["lifesteal", "sustain"],
  },
  {
    id: "lifesteal",
    term: "Vol de vie",
    aliases: ["lifesteal", "vol de vie"],
    category: "objets",
    definition:
      "Soigne le champion d'un pourcentage des dégâts infligés par ses attaques de base. Le vol de vie est courant chez les ADC et certains combattants.",
    related: ["omnivamp", "ad", "sustain"],
  },
  {
    id: "tenacity",
    term: "Ténacité",
    aliases: ["tenacity", "ténacité"],
    category: "objets",
    definition:
      "Statistique qui réduit la durée de certains contrôles de foule. Elle ne protège pas contre tous les effets (certaines projections et suppressions ignorent la ténacité).",
    related: ["cc", "mr", "slow-resist"],
  },
  {
    id: "slow-resist",
    term: "Résistance aux ralentissements",
    aliases: ["slow resist", "résistance aux ralentissements"],
    category: "objets",
    definition:
      "Statistique qui réduit l'intensité des ralentissements subis. Elle est utile contre les champions qui contrôlent en permanence par des ralentissements.",
    related: ["tenacity", "cc", "kite"],
  },
  {
    id: "move-speed",
    term: "Vitesse de déplacement",
    aliases: ["move speed", "ms", "vitesse de déplacement"],
    category: "objets",
    definition:
      "Statistique qui détermine la vitesse à laquelle un champion se déplace. Elle est essentielle pour esquiver, engager, rejoindre les objectifs et kite.",
    related: ["boots", "kite", "rotate"],
  },
  {
    id: "boots",
    term: "Bottes",
    aliases: ["boots", "bottes", "chaussures"],
    category: "objets",
    definition:
      "Objet qui augmente la vitesse de déplacement et peut être amélioré pour gagner une statistique ou un effet. Les bottes sont un achat quasi systématique.",
    related: ["move-speed", "item-spike"],
  },
  {
    id: "item-spike",
    term: "Pic d'objet",
    aliases: ["item spike", "power spike d'objet", "spike d'objet"],
    category: "objets",
    definition:
      "Moment où un champion termine un objet important et devient nettement plus fort. Connaître ces pics aide à choisir quand combattre ou éviter l'adversaire.",
    related: ["power-spike", "gold", "boots"],
  },
  {
    id: "component",
    term: "Composant",
    aliases: ["component", "composants", "recette"],
    category: "objets",
    definition:
      "Objet intermédiaire acheté en attendant de terminer un objet plus cher. Les composants donnent parfois un petit pic de puissance immédiat.",
    related: ["item-spike", "gold"],
  },
  {
    id: "cooldown",
    term: "Temps de recharge",
    aliases: ["cooldown", "cd", "recharge"],
    category: "objets",
    definition:
      "Délai avant de pouvoir réutiliser un sort. Suivre les temps de recharge adverses permet de mieux choisir le moment d'un trade ou d'un all-in.",
    related: ["haste", "trade", "all-in"],
  },

  // --- Runes ----------------------------------------------------------
  {
    id: "keystone",
    term: "Keystone",
    aliases: ["rune majeure", "keystone", "rune clé"],
    category: "runes",
    definition:
      "Rune principale d'un arbre, choisie parmi quatre options. La keystone définit souvent le style de la page (dégâts, survie, mobilité, etc.).",
    related: ["primary-tree", "rune-page"],
  },
  {
    id: "primary-tree",
    term: "Arbre principal",
    aliases: ["primary tree", "arbre primaire"],
    category: "runes",
    definition:
      "Premier arbre de runes choisi dans une page ; il contient la keystone et trois runes mineures. L'arbre secondaire en apporte deux supplémentaires.",
    related: ["keystone", "secondary-tree"],
  },
  {
    id: "secondary-tree",
    term: "Arbre secondaire",
    aliases: ["secondary tree", "arbre secondaire"],
    category: "runes",
    definition:
      "Second arbre de runes d'une page, qui apporte deux runes mineures choisies parmi ses paliers. Il complète les effets de l'arbre principal.",
    related: ["primary-tree", "rune-page"],
  },
  {
    id: "stat-shard",
    term: "Fragment de stats",
    aliases: ["stat shard", "shard", "fragments"],
    category: "runes",
    definition:
      "Petit bonus de statistique choisi en bas d'une page de runes, par exemple vitesse d'attaque, force adaptative ou PV. Trois fragments sont sélectionnés.",
    related: ["rune-page", "primary-tree"],
  },
  {
    id: "rune-page",
    term: "Page de runes",
    aliases: ["rune page", "page de runes"],
    category: "runes",
    definition:
      "Ensemble d'une keystone, de runes mineures et de trois fragments. Une page de runes est sélectionnée avant la partie pour adapter le champion à son rôle.",
    related: ["keystone", "primary-tree", "stat-shard"],
  },

  // --- Rangs & progression --------------------------------------------
  {
    id: "lp",
    term: "LP",
    aliases: ["league points", "points de ligue"],
    category: "progression",
    definition:
      "Points de ligue gagnés ou perdus à chaque partie classée. Ils permettent de progresser dans une division et vers le rang supérieur.",
    related: ["rank", "division"],
  },
  {
    id: "rank",
    term: "Rang",
    aliases: ["rank", "classement", "tier"],
    category: "progression",
    definition:
      "Niveau de classement d'un joueur en mode classé (Fer, Bronze, Argent, Or, Platine, Émeraude, Diamant, Maître, Grand Maître, Challenger). Le rang est précisé par une division et des LP.",
    related: ["division", "lp", "mmr"],
  },
  {
    id: "division",
    term: "Division",
    aliases: ["division", "palier"],
    category: "progression",
    definition:
      "Sous-niveau d'un rang (par exemple Or II). Les divisions se traversent en accumulant des LP ; les rangs élevés n'ont parfois qu'une seule division.",
    related: ["rank", "lp"],
  },
  {
    id: "mmr",
    term: "MMR",
    aliases: ["matchmaking rating", "elo", "elo caché"],
    category: "progression",
    definition:
      "Niveau interne estimé par le matchmaking, invisible dans le jeu. Le MMR influence les adversaires rencontrés et les LP gagnés ou perdus.",
    related: ["lp", "rank"],
  },
  {
    id: "placement",
    term: "Parties de placement",
    aliases: ["placements", "placement", "classement initial"],
    category: "progression",
    definition:
      "Parties classées jouées en début de saison ou de split pour déterminer le rang initial. Le résultat dépend notamment du MMR et des performances.",
    related: ["rank", "split"],
  },
  {
    id: "split",
    term: "Split",
    aliases: ["saison classée", "split", "season"],
    category: "progression",
    definition:
      "Période de la saison classée, avec ses récompenses et parfois une remise à niveau partielle. Les rangs et LP sont suivis par split.",
    related: ["rank", "placement"],
  },
  {
    id: "solo-duo",
    term: "Solo/Duo",
    aliases: ["solo queue", "soloq", "classée solo", "ranked solo"],
    category: "progression",
    definition:
      "File classée où l'on peut jouer seul ou à deux. C'est la file de référence pour le classement individuel.",
    related: ["flex", "rank"],
  },
  {
    id: "flex",
    term: "Flex",
    aliases: ["flex queue", "classée flex", "ranked flex"],
    category: "progression",
    definition:
      "File classée en équipe de 1 à 5 joueurs, avec un classement distinct de la Solo/Duo. Elle est souvent utilisée pour jouer entre amis.",
    related: ["solo-duo", "rank"],
  },
  {
    id: "normal",
    term: "Partie normale",
    aliases: ["normal", "normal game", "non classé", "blind pick"],
    category: "progression",
    definition:
      "File non classée où le résultat n'affecte pas le rang. Elle sert à s'entraîner, tester des champions ou jouer sans pression.",
    related: ["draft", "aram"],
  },
  {
    id: "aram",
    term: "ARAM",
    aliases: ["all random all mid", "aram"],
    category: "progression",
    definition:
      "Mode où chaque joueur reçoit un champion aléatoire sur la Faille de l'invocateur, avec une seule voie centrale. Les parties sont rapides et centrées sur les combats.",
    related: ["normal", "teamfight"],
  },
  {
    id: "draft",
    term: "Draft",
    aliases: ["champion select", "sélection des champions", "phase de pick"],
    category: "progression",
    definition:
      "Phase de sélection des champions et des sorts avant la partie. Les picks et bans y préparent la composition et les matchups.",
    related: ["pick", "ban-rate", "comp"],
  },
  {
    id: "dodge",
    term: "Dodge",
    aliases: ["esquiver", "dodge", "annuler la partie"],
    category: "progression",
    definition:
      "Quitter la sélection des champions avant le début de la partie. Un dodge évite un mauvais matchup mais entraîne une pénalité de file.",
    related: ["draft", "queue"],
  },
  {
    id: "queue",
    term: "File d'attente",
    aliases: ["queue", "file", "matchmaking"],
    category: "progression",
    definition:
      "Système qui rassemble les joueurs pour former une partie. Le temps d'attente et les coéquipiers dépendent du mode et du MMR.",
    related: ["mmr", "solo-duo"],
  },
  {
    id: "remake",
    term: "Remake",
    aliases: ["remake", "annulation en début de partie"],
    category: "progression",
    definition:
      "Annulation d'une partie quand un joueur est absent ou déconnecté dès le début. Le remake évite de jouer un 4v5 et limite les pertes.",
    related: ["afk", "queue"],
  },
  {
    id: "afk",
    term: "AFK",
    aliases: ["away from keyboard", "absent", "inactif"],
    category: "progression",
    definition:
      "Joueur absent ou inactif pendant la partie. L'AFK pénalise son équipe et peut être sanctionné par le système de jeu.",
    related: ["remake", "tilt"],
  },
  {
    id: "smurf",
    term: "Smurf",
    aliases: ["smurf", "compte secondaire", "reroll"],
    category: "progression",
    definition:
      "Joueur expérimenté qui utilise un compte de niveau inférieur pour affronter des adversaires moins forts. Le smurf fausse le matchmaking et l'expérience des débutants.",
    related: ["mmr", "rank"],
  },
  {
    id: "tilt",
    term: "Tilt",
    aliases: ["tilt", "énervement", "frustration"],
    category: "progression",
    definition:
      "État émotionnel négatif qui dégrade les décisions et la communication. Faire une pause est souvent plus efficace que continuer à jouer tilté.",
    related: ["mentality", "afk"],
  },
  {
    id: "mentality",
    term: "Mental",
    aliases: ["mentality", "mental", "état d'esprit"],
    category: "progression",
    definition:
      "Capacité à garder une attitude stable malgré les erreurs et les défaites. Un bon mental aide à rester concentré et à éviter le tilt.",
    related: ["tilt"],
  },

  // --- Méta & analyse --------------------------------------------------
  {
    id: "meta",
    term: "Méta",
    aliases: ["meta", "méta", "méta-game"],
    category: "meta",
    definition:
      "Ensemble des stratégies, champions et objets considérés comme les plus efficaces dans une version du jeu. Le méta évolue avec les correctifs et les découvertes des joueurs.",
    related: ["tier-list", "patch"],
  },
  {
    id: "tier-list",
    term: "Tier list",
    aliases: ["tierlist", "tier list", "classement des champions"],
    category: "meta",
    definition:
      "Classement des champions par niveau de puissance perçu, souvent par rôle et par rang. Une tier list est une analyse, pas une vérité absolue.",
    related: ["meta", "win-rate", "pick-rate"],
  },
  {
    id: "win-rate",
    term: "Taux de victoire",
    aliases: ["win rate", "winrate", "taux de victoire"],
    category: "meta",
    definition:
      "Pourcentage de parties gagnées parmi les parties jouées. Le taux de victoire doit être lu avec le nombre de parties et le contexte (rang, rôle, version).",
    related: ["pick-rate", "ban-rate", "tier-list"],
  },
  {
    id: "pick-rate",
    term: "Taux de sélection",
    aliases: ["pick rate", "pickrate", "popularité"],
    category: "meta",
    definition:
      "Pourcentage de parties où un champion (ou un objet) est choisi. Un pick rate élevé indique une forte popularité, pas forcément un avantage.",
    related: ["win-rate", "ban-rate", "meta"],
  },
  {
    id: "ban-rate",
    term: "Taux de ban",
    aliases: ["ban rate", "banrate", "banni"],
    category: "meta",
    definition:
      "Pourcentage de parties où un champion est banni. Il reflète la gêne qu'il représente pour les joueurs, pas seulement sa puissance brute.",
    related: ["pick-rate", "draft", "meta"],
  },
  {
    id: "off-meta",
    term: "Off-meta",
    aliases: ["off meta", "hors méta"],
    category: "meta",
    definition:
      "Choix de champion, d'objet ou de rune en dehors des stratégies les plus populaires. Un choix off-meta peut surprendre, mais n'est pas automatiquement mauvais.",
    related: ["meta", "pocket-pick"],
  },
  {
    id: "pocket-pick",
    term: "Pocket pick",
    aliases: ["pocket pick", "pick de poche"],
    category: "meta",
    definition:
      "Champion qu'un joueur maîtrise particulièrement et sort dans des situations précises. Le pocket pick repose sur l'expérience personnelle plus que sur le méta.",
    related: ["off-meta", "one-trick"],
  },
  {
    id: "one-trick",
    term: "One-trick",
    aliases: ["one trick", "one trick pony", "otp"],
    category: "meta",
    definition:
      "Joueur qui joue presque exclusivement un seul champion. La maîtrise du champion peut compenser ses faiblesses de matchup.",
    related: ["pocket-pick", "matchup"],
  },
  {
    id: "matchup",
    term: "Matchup",
    aliases: ["match up", "confrontation", "duel de champions"],
    category: "meta",
    definition:
      "Confrontation entre deux champions sur une voie, avec leurs forces et faiblesses respectives. Le matchup dépend du rôle, de la version et de la maîtrise des joueurs.",
    related: ["counter", "lane", "tier-list"],
  },
  {
    id: "counter",
    term: "Counter",
    aliases: ["counterpick", "contre", "contre-pick"],
    category: "meta",
    definition:
      "Champion ou stratégie qui a un avantage naturel contre un autre. Un counter n'est pas automatique : le niveau de jeu et la composition comptent aussi.",
    related: ["matchup", "draft", "synergy"],
  },
  {
    id: "synergy",
    term: "Synergie",
    aliases: ["synergy", "combinaison", "combo"],
    category: "meta",
    definition:
      "Interaction favorable entre deux champions ou plus, par exemple un engage suivi d'un burst de zone. La synergie se construit autant en draft qu'en jeu.",
    related: ["comp", "teamfight", "counter"],
  },
  {
    id: "comp",
    term: "Composition",
    aliases: ["comp", "team comp", "composition d'équipe"],
    category: "meta",
    definition:
      "Ensemble des cinq champions d'une équipe, avec leurs forces et leurs plans de jeu. Une composition équilibrée combine frontline, dégâts et contrôle.",
    related: ["synergy", "draft", "teamfight"],
  },
  {
    id: "patch",
    term: "Correctif",
    aliases: ["patch", "version", "mise à jour"],
    category: "meta",
    definition:
      "Mise à jour du jeu qui modifie les champions, objets ou systèmes. Les données de la méta changent à chaque correctif ; l'application met ses caches à jour via Data Dragon/OP.GG.",
    related: ["meta", "tier-list"],
  },
  {
    id: "assassin",
    term: "Assassin",
    aliases: ["assassin", "tueur"],
    category: "meta",
    definition:
      "Classe de champions spécialisés dans l'élimination rapide de cibles fragiles, souvent avec de la mobilité et du burst. Les assassins cherchent les cibles isolées.",
    related: ["burst", "pick", "mid"],
  },
];
