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

            // Upsert (Sove oswa mete ajou san l pa reni sa ki la deja)
            const { data: savedMatch, error: matchErr } = await supabase
                .from("matches")
                .upsert([{
                    league: league,
                    home_team: homeTeam,
                    away_team: awayTeam,
                    match_time: matchTime,
                    status: match.status
                }], { onConflict: 'league, home_team, away_team, match_time' })
                .select()
                .single();

            if (matchErr) {
                errors.push(`Match Insert Err: ${matchErr.message}`);
                // Si upsert ba w erè akòz ti spesifikasyon, ann kouri yon insert senp
                const { data: fallbackMatch, error: fallbackErr } = await supabase
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

                if (fallbackErr) {
                    errors.push(`Fallback Err: ${fallbackErr.message}`);
                    continue;
                }
            }

            const activeMatch = savedMatch || fallbackMatch;

            // Rele Gemini pou pronostik ak analiz
            const model = genAI.getGenerativeModel({
                model: "gemini-1.5-pro",
                tools: [{ googleSearch: {} }]
            });

            const prompt = `
            Analize match sa a: ${homeTeam} vs ${awayTeam}.
            1. Fè rechèch sou sit 'Betmines' pou pronostik ekip k ap genyen an ak % konfyans.
            2. Fè rechèch sou Google pou H2H, fòm 5 dènye jwèt yo, 11 jwè (line-up), ak analiz an kreyòl ayisyen.
            
            Reponn SÈLMAN nan fòma JSON sa a:
            {
              "option_name": "Victoire ${homeTeam}",
              "confidence": 80,
              "risk_level": "Faible",
              "ai_analysis_text": "Tèks analiz an kreyòl...",
              "lineup_json": { "home": [], "away": [] }
            }
            `;

            try {
                const aiResult = await model.generateContent(prompt);
                const rawText = aiResult.response.text();
                const cleanJson = rawText.replace(/```json|```/g, "").trim();
                const aiData = JSON.parse(cleanJson);

                await supabase.from("predictions").insert([{
                    match_id: activeMatch.id,
                    option_name: aiData.option_name,
                    confidence: aiData.confidence,
                    risk_level: aiData.risk_level,
                    ai_analysis_text: aiData.ai_analysis_text,
                    lineup_json: aiData.lineup_json
                }]);

                count++;
            } catch (err) {
                errors.push(`Gemini Err: ${err.message}`);
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
