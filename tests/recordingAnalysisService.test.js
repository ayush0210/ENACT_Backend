import assert from 'node:assert/strict';
import test from 'node:test';
import { recordingAnalysisInternals } from '../services/recordingAnalysisService.js';

const { keywordSegments, normalizeSegments, buildMetrics, countWords } =
    recordingAnalysisInternals;

test('counts words without counting empty whitespace', () => {
    assert.equal(countWords('  we planted a seed  '), 4);
    assert.equal(countWords(''), 0);
});

test('keyword fallback returns exact transcript offsets', () => {
    const transcript = 'We planted a seed and watched it grow with a friend.';
    const segments = keywordSegments(transcript);
    assert.ok(
        segments.some(
            segment =>
                segment.category === 'science' &&
                segment.text.toLowerCase() === 'grow',
        ),
    );
    assert.ok(
        segments.some(
            segment =>
                segment.category === 'social' &&
                segment.text.toLowerCase() === 'friend',
        ),
    );
    for (const segment of segments) {
        assert.equal(
            transcript.slice(segment.startIndex, segment.endIndex),
            segment.text,
        );
    }
});

test('rejects hallucinated LLM segments and removes overlaps', () => {
    const transcript = 'The child shared a science book.';
    const segments = normalizeSegments(transcript, [
        { text: 'shared a science book', category: 'science' },
        { text: 'science book', category: 'literature' },
        { text: 'not in transcript', category: 'social' },
    ]);
    assert.deepEqual(segments, [
        {
            text: 'shared a science book',
            category: 'science',
            startIndex: 10,
            endIndex: 31,
        },
    ]);
});

test('builds category percentages and WPM from classified words', () => {
    const metrics = buildMetrics(
        [
            { text: 'one two three', category: 'science' },
            { text: 'hello friend', category: 'social' },
        ],
        60,
    );
    assert.deepEqual(metrics.categoryWordCounts, {
        science: 3,
        social: 2,
        literature: 0,
        language: 0,
    });
    assert.equal(metrics.categoryPercentages.science, 60);
    assert.equal(metrics.categoryPercentages.social, 40);
    assert.equal(metrics.categoryWpm.science, 3);
});
