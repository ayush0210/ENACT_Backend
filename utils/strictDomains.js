// Strict domain definitions - ONLY these 4 domains are allowed

export const ALLOWED_DOMAINS = {
    'Language Development': {
      keywords: [
        'talk', 'speak', 'language', 'vocabulary', 'word', 'communicate',
        'conversation', 'speech', 'verbal', 'storytelling', 'listening',
        'pronunciation', 'bilingual', 'reading aloud', 'narration',
        'questions', 'describing', 'rhyme', 'song', 'singing'
      ],
      patterns: [
        /\b(language|speech|talk|word|vocabulary|communicate)\b/i,
        /\b(storytelling|narrat|conversation|verbal)\b/i,
        /\b(bilingual|pronunciation|listening)\b/i
      ]
    },
    'Early Science Skills': {
      keywords: [
        'science', 'experiment', 'explore', 'discover', 'observe', 'investigate',
        'nature', 'plants', 'animals', 'weather', 'seasons', 'biology',
        'physics', 'chemistry', 'stem', 'curiosity', 'wonder', 'hypothesis',
        'predict', 'measure', 'compare', 'classify', 'scientific'
      ],
      patterns: [
        /\b(science|experiment|stem|discover|observe)\b/i,
        /\b(nature|plants?|animals?|weather|seasons?)\b/i,
        /\b(hypothesis|predict|measure|investigate)\b/i
      ]
    },
    'Literacy Foundations': {
      keywords: [
        'read', 'reading', 'book', 'letter', 'alphabet', 'phonics', 'literacy',
        'writing', 'story', 'print', 'text', 'comprehension', 'author',
        'illustration', 'library', 'spell', 'recognize', 'sight word',
        'pre-reading', 'emergent literacy', 'print awareness'
      ],
      patterns: [
        /\b(read|literacy|book|story|letter|alphabet)\b/i,
        /\b(phonics|writing|spell|print|text)\b/i,
        /\b(comprehension|sight word|pre-reading)\b/i
      ]
    },
    'Social-Emotional Learning': {
      keywords: [
        'emotion', 'emotions', 'feeling', 'feelings', 'empathy', 'social', 'friend', 'share', 'turn-taking',
        'cooperation', 'kindness', 'self-regulation', 'calm', 'upset', 'angry',
        'sad', 'happy', 'scared', 'frustrated', 'conflict', 'resolution',
        'relationship', 'self-awareness', 'self-control', 'coping', 'mindfulness',
        'patience', 'understanding', 'compassion', 'jealous', 'proud', 'activity', 'activities'
      ],
      patterns: [
        /\b(emotion|emotions|feeling|feelings|empathy|social|friend)\b/i,
        /\b(share|sharing|turn-taking|cooperation|kindness)\b/i,
        /\b(self-regulation|calm|upset|angry|sad|frustrated)\b/i,
        /\b(conflict|relationship|coping|mindfulness)\b/i,
        /\b(activity|activities)\b/i
      ]
    }
  };
  
  // Topics explicitly OUT of scope (reject immediately)
  const OUT_OF_SCOPE_TOPICS = [
    // Violence/harm (NEVER allowed - safety critical)
    /\b(kill|murder|hurt|harm|attack|violent|weapon|gun|knife|death|die|suicide)\b/i,
    /\b(abuse|neglect|poison|dangerous|unsafe|illegal)\b/i,

    // Behavioral/discipline (not in our domains)
    /\b(discipline|punishment|consequence|timeout|reward|chart|behavior modification)\b/i,
    /\b(tantrum|meltdown|defiance|backtalk|hitting|biting|kicking)\b/i,
    
    // Sleep (not in our domains)
    /\b(sleep|bedtime|nap|nighttime|wake|insomnia)\b/i,
    
    // Eating/nutrition (not in our domains)
    /\b(eating|food|meal|nutrition|picky eater|snack|diet|feeding)\b/i,
    
    // Potty training (not in our domains)
    /\b(potty|toilet|diaper|bathroom|pee|poop|training)\b/i,
    
    // Screen time (not in our domains)
    /\b(screen time|tablet|ipad|tv|television|video game|youtube)\b/i,
    
    // Homework/school admin (not in our domains)
    /\b(homework|grade|test|quiz|school meeting|teacher conference)\b/i,
    
    // Travel/logistics (not in our domains)
    /\b(travel|vacation|flight|hotel|car seat|stroller)\b/i,
    
    // Medical/health (never allowed - legal risk)
    /\b(diagnos|symptom|treatment|medicine|medication|doctor|illness|disease|injury|medical)\b/i,
    /\b(fever|rash|cough|cold|flu|allergy|asthma|adhd|autism|delay)\b/i,
    
    // Financial/legal (never allowed)
    /\b(custody|divorce|lawyer|legal|court|financial|money|budget|cost)\b/i,
    
    // Adult topics
    /\b(sex|dating|relationship with partner|marriage counseling)\b/i
  ];
  
  export function isStrictlyInScope(query) {
    const q = String(query || '').toLowerCase();

    // 1. Check for explicitly out-of-scope topics
    for (let i = 0; i < OUT_OF_SCOPE_TOPICS.length; i++) {
      const pattern = OUT_OF_SCOPE_TOPICS[i];
      if (pattern.test(q)) {
        // Different message for violence/harmful content (first 2 patterns)
        if (i < 2) {
          return {
            isValid: false,
            reason: 'harmful_content',
            message: 'We cannot provide advice on this topic. Our focus is on positive, safe parenting strategies in Language Development, Early Science Skills, Literacy Foundations, and Social-Emotional Learning.'
          };
        }
        return {
          isValid: false,
          reason: 'out_of_scope',
          message: 'This topic is outside our 4 core domains: Language Development, Early Science Skills, Literacy Foundations, and Social-Emotional Learning.'
        };
      }
    }
    
    // 2. Must match at least ONE of our 4 domains
    let matchedDomain = null;
    let maxMatches = 0;
    
    for (const [domain, config] of Object.entries(ALLOWED_DOMAINS)) {
      let matches = 0;
      
      // Check keyword matches
      for (const keyword of config.keywords) {
        if (q.includes(keyword)) matches++;
      }
      
      // Check pattern matches
      for (const pattern of config.patterns) {
        if (pattern.test(q)) matches += 2; // patterns worth more
      }
      
      if (matches > maxMatches) {
        maxMatches = matches;
        matchedDomain = domain;
      }
    }
    
    // Require at least 2 matches to be confident it's in-domain
    if (maxMatches < 2) {
      return {
        isValid: false,
        reason: 'unclear_domain',
        message: 'Please ask about Language Development, Early Science Skills, Literacy Foundations, or Social-Emotional Learning.'
      };
    }
    
    return {
      isValid: true,
      domain: matchedDomain,
      confidence: maxMatches
    };
  }
  
  export const REJECTION_MESSAGE = `We only provide parenting tips in these 4 areas:
  
  - **Language Development** - vocabulary, communication, storytelling
  - **Early Science Skills** - exploration, observation, curiosity about nature
  - **Literacy Foundations** - reading, books, letters, phonics
  - **Social-Emotional Learning** - feelings, empathy, friendships, self-regulation
  
  Try asking about one of these topics!`;