// Test question detection patterns

function isQuestion(prompt) {
    const sanitizedPrompt = prompt.toLowerCase().trim();

    return (
        /\b(what|how|why|when|where|should|can|could|would|do|does|is|are)\b.*\?/i.test(sanitizedPrompt) ||
        /\b(what|how|why|should|can|could|would)\b.*\b(do|does|gonna|going to|should|activities|activity|ideas)\b/i.test(sanitizedPrompt) ||
        /\b(what|how)\s+(should|can|could|do|to do)\b/i.test(sanitizedPrompt) ||
        /\b(give me|tell me|show me|help me|suggest|recommend)\b/i.test(sanitizedPrompt) ||
        /\btoday\b.*\b(what|how|should|do)\b/i.test(sanitizedPrompt)
    );
}

console.log('🧪 Testing Question Detection\n');

const testCases = [
    // Should be detected as questions (AI generation)
    { query: "What you gonna do with my kid today", expected: true },
    { query: "I'm going shopping with my kid today what should I do", expected: true },
    { query: "What should I do?", expected: true },
    { query: "How do I teach sharing?", expected: true },
    { query: "Give me tips for bedtime", expected: true },
    { query: "Tell me about potty training", expected: true },
    { query: "Show me activities for 2-year-old", expected: true },
    { query: "Help me with tantrums", expected: true },
    { query: "What activities for today", expected: true },
    { query: "How can I handle this?", expected: true },

    // Should NOT be detected as questions (DB search)
    { query: "sharing tips", expected: false },
    { query: "potty training", expected: false },
    { query: "bedtime routine", expected: false },
    { query: "language development", expected: false },
    { query: "emotional regulation strategies", expected: false },
];

let passed = 0;
let failed = 0;

testCases.forEach(({ query, expected }) => {
    const result = isQuestion(query);
    const status = result === expected ? '✅' : '❌';

    if (result === expected) {
        passed++;
    } else {
        failed++;
    }

    console.log(`${status} "${query}"`);
    console.log(`   Expected: ${expected ? 'Question (AI)' : 'Topic (DB)'}`);
    console.log(`   Got: ${result ? 'Question (AI)' : 'Topic (DB)'}`);

    if (result !== expected) {
        console.log(`   ⚠️  MISMATCH!`);
    }
    console.log('');
});

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);

if (failed === 0) {
    console.log('✅ All tests passed!');
} else {
    console.log(`❌ ${failed} tests failed`);
    process.exit(1);
}
