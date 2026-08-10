import express from 'express';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const FOOTBALL_DATA_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.get('/cron/sync-matches', async (req, res) => {
    try {
        const response = await fetch("https://api.football-data.org/v4/matches", {
            headers: { "X-Auth-Token": FOOTBALL_DATA_TOKEN }
        });
        
        const data = await response.json();
        
        if (data.message) {
            return res.status(400).json({ error: data.message });
        }

        const matches = data.matches || [];
        let count = 0;
        let errors = [];

        for (const match of matches) {
            const homeTeam = match.homeTeam.name;
            const awayTeam = match.awayTeam.name;
            const league = match.competition.name;
            const matchTime = match.utcDate;

            let activeMatch = null;

            // 1. Tcheke si match la deja nan baz de done a
            const { data: existingMatch } = await supabase
                .from("matches")
                .select("*")
                .eq("home_team", homeTeam)
                .eq("away_team", awayTeam)
                .eq("match_time", matchTime)
                .single();

            if (existingMatch) {
                activeMatch = existingMatch;
            } else {
                // 2. Insérer match la si l pa la
                const { data: insertedMatch, error: insertErr } = await supabase
                    .from("matches")
                    .insert([{
                        league: league,
                        home_team: homeTeam,
                        away_team: awayTeam,
                        match_time: matchTime,
                        status: match.status
                    }])
                    .select()
                    .single();

                if (insertErr) {
                    errors.push(`Insert Err (${homeTeam}): ${insertErr.message}`);
                    continue;
                }
                activeMatch = insertedMatch;
            }

            // 3. Tcheke si gen prediksyon pou match la deja
            const { data: existingPred } = await supabase
                .from("predictions")
                .select("id")
                .eq("match_id", activeMatch.id)
                .single();

            if (existingPred) {
                count++;
                continue;
            }

            // 4. Rele Gemini dirèkteman via HTTP Fetch (evite erè SDK ak modèl 404)
            const prompt = `
            Analize match sa a: ${homeTeam} vs ${awayTeam}.
            Ekri yon analiz ak pronostik an kreyòl ayisyen.
            
            Reponn SÈLMAN anndan fòma JSON sa a presizman:
            {
              "option_name": "Victoire ${homeTeam}",
              "confidence": 75,
              "risk_level": "Moyen",
              "ai_analysis_text": "Ekip ${homeTeam} an gen yon bon fòm...",
              "lineup_json": { "home": [], "away": [] }
            }
            `;

            try {
                const geminiRes = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            contents: [{ parts: [{ text: prompt }] }]
                        })
                    }
                );

                const geminiData = await geminiRes.json();

                if (geminiData.error) {
                    errors.push(`Gemini API Err (${homeTeam}): ${geminiData.error.message}`);
                    continue;
                }

                const rawText = geminiData.candidates[0].content.parts[0].text;
                const cleanJson = rawText.replace(/```json|```/g, "").trim();
                const aiData = JSON.parse(cleanJson);

                // Anrejistre prediksyon an nan Supabase
                await supabase.from("predictions").insert([{
                    match_id: activeMatch.id,
                    option_name: aiData.option_name,
                    confidence: aiData.confidence,
                    risk_level: aiData.risk_level,
                    ai_analysis_text: aiData.ai_analysis_text,
                    lineup_json: aiData.lineup_json
                }]);

                count++;
                await sleep(2000); // Paus 2 segonn

            } catch (err) {
                errors.push(`Gemini Catch Err (${homeTeam}): ${err.message}`);
            }
        }

        res.json({ 
            success: true, 
            matches_processed: count, 
            total_matches_found: matches.length,
            debug_errors: errors 
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => console.log(`Server ap kouri sou pòt ${PORT}`));
