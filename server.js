import express from 'express';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const FOOTBALL_DATA_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Fonksyon pou fè yon ti pause pou pa depase quota API la
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

            // 1. Tcheke si match la nan baz de done a
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

            // 3. Tcheke si gen prediksyon pou match sa a deja nan Supabase
            const { data: existingPred } = await supabase
                .from("predictions")
                .select("id")
                .eq("match_id", activeMatch.id)
                .single();

            if (existingPred) {
                // Si l gen prediksyon deja, pa bezwen rele Gemini ankò!
                count++;
                continue;
            }

            // 4. Rele Gemini ak modèl "gemini-2.0-flash"
            try {
                const model = genAI.getGenerativeModel({
                    model: "gemini-2.0-flash"
                });

                const prompt = `
                Analize match balondfen sa a: ${homeTeam} vs ${awayTeam}.
                Ekri yon analiz ak pronostik an kreyòl ayisyen.
                
                Reponn SÈLMAN nan fòma JSON sa a presizman:
                {
                  "option_name": "Victoire ${homeTeam}",
                  "confidence": 75,
                  "risk_level": "Moyen",
                  "ai_analysis_text": "Ekip ${homeTeam} an gen yon bon fòm...",
                  "lineup_json": { "home": [], "away": [] }
                }
                `;

                const aiResult = await model.generateContent(prompt);
                const rawText = aiResult.response.text();
                const cleanJson = rawText.replace(/```json|```/g, "").trim();
                const aiData = JSON.parse(cleanJson);

                // Anrejistre prediksyon an
                await supabase.from("predictions").insert([{
                    match_id: activeMatch.id,
                    option_name: aiData.option_name,
                    confidence: aiData.confidence,
                    risk_level: aiData.risk_level,
                    ai_analysis_text: aiData.ai_analysis_text,
                    lineup_json: aiData.lineup_json
                }]);

                count++;
                // Tann 3 segonn ant chak match pou pa sature quota Gemini an
                await sleep(3000);

            } catch (err) {
                errors.push(`Gemini Err (${homeTeam}): ${err.message}`);
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
