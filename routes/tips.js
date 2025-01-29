import express from 'express';
import { OpenAI } from 'openai';
import pool from '../config/db';

const router = express.Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

router.post('/get-tips', async (req, res) => {
    try {
        const { type, AI } = req.body;
        const [rows] = await pool.query('SELECT * FROM tips WHERE type = ?', [type]);

        if (!AI) {
            const tips = [];
            const randomIndices = [];
            while (randomIndices.length < 3 && randomIndices.length < rows.length) {
                const randomIndex = Math.floor(Math.random() * rows.length);
                if (!randomIndices.includes(randomIndex)) {
                    randomIndices.push(randomIndex);
                    tips.push(rows[randomIndex]);
                }
            }
            return res.status(200).json(tips);
        } else {
            const prompt = rows
                .map(row => `Tip: ${row.title}\nDescription: ${row.description}`)
                .join('\n\n');

            const completion = await openai.chat.completions.create({
                model: 'gpt-3.5-turbo',
                messages: [
                    {
                        role: 'system',
                        content: 'You are an assistant that generates helpful tips for parents based on existing data. Respond with 3 new tips in JSON format.',
                    },
                    {
                        role: 'user',
                        content: `Generate 3 new tips based on the following data:\n\n${prompt}\n\nRespond with 3 tips in this JSON format:\n[{"id": 1, "type": "Generated", "title": "Tip Title 1", "description": "Tip description 1"},{"id": 2, "type": "Generated", "title": "Tip Title 2", "description": "Tip description 2"},{"id": 3, "type": "Generated", "title": "Tip Title 3", "description": "Tip description 3"}]`,
                    },
                ],
                max_tokens: 500,
                n: 1,
            });

            const assistantMessage = completion.choices[0].message.content;
            let generatedTips;

            try {
                // Use a regular expression to extract JSON from the response
                const jsonMatch = assistantMessage.match(/\[[\s\S]*\]/);
                if (jsonMatch) {
                    generatedTips = JSON.parse(jsonMatch[0]);
                } else {
                    throw new Error('No JSON array found in the response');
                }

                // Ensure we have exactly 3 tips
                if (!Array.isArray(generatedTips) || generatedTips.length !== 3) {
                    throw new Error('Response does not contain exactly 3 tips');
                }

                // Update the IDs to continue from the existing tips
                generatedTips = generatedTips.map((tip, index) => ({
                    ...tip,
                    id: rows.length + index + 1
                }));

            } catch (error) {
                console.error('Error parsing JSON:', error);
                console.error('Raw response:', assistantMessage);
                return res.status(500).json({ message: 'Error generating tips', error: error.message });
            }

            return res.status(200).json(generatedTips);
        }
    } catch (error) {
        console.error('Error in fetching tips', error);
        return res.status(500).json({ message: 'No tips found', error: error.message });
    }
});

export default router;