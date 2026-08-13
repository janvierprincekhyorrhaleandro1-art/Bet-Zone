const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://uiepdartkcunumajlwwg.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'sb_secret_QkRjPE0nGdy5Y74SOAaoDw_BUrAn7ju';
const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_KEY || '1d6fdcd8b34649fdaf25ddbbb47ac3ac';
const GEMINI_KEY = process.env.GEMINI_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Fonksyon pou fòse sèvè a tann (delay)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 1. Rale match pou 10 jou devan pou mete nan kalandriye Supabase la
async function syncDailyMatches() {
    console.log(`⏰ [${new Date().toISOString()}] Ekzekisyon senkronizasyon match...`);

    const todayDate = new Date();
    const futureDate = new Date();
    futureDate.setDate(todayDate.getDate() + 10);

    const today = todayDate.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const toDateStr = futureDate.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    console.log(`📅 Chèche match pou kalandriye ant: ${today} ak ${toDateStr}`);

    try {
        const response = await fetch(`https://api.football-data.org/v4/matches?competitions=PL,PD,BL1,SA,FL1,CL&dateFrom=${today}&dateTo=${toDateStr}`, {
            headers: { 'X-Auth-Token': FOOTBALL_DATA_KEY }
        });

        const data = await response.json();

        if (data.message) {
            console.error("❌ Erè ki soti nan Football-Data.org:", data.message);
            return;
        }

        if (data.matches && data.matches.length > 0) {
            console.log(`⚽ Jwenn ${data.matches.length} match sou Football-Data.org.`);

            const { data: existingMatches } = await supabase.from('daily_matches').select('id, victory, percent');
            const existingMap = new Map(existingMatches?.map(m => [m.id, m]) || []);

            const formattedMatches = data.matches.map(item => {
                const code = item.competition.code || 'ALL';
                const realMatchDate = item.utcDate ? item.utcDate.split('T')[0] : today;
                const existing = existingMap.get(item.id);

                return {
                    id: item.id,
                    league_code: code,
                    league_name: item.competition.name,
                    match_date: realMatchDate,
                    match_time: new Date(item.utcDate).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' }),
                    team_a: item.homeTeam.name,
                    team_b: item.awayTeam.name,
                    victory: existing ? existing.victory : null,
                    percent: existing ? existing.percent : null
                };
            });

            const { error: insErr } = await supabase.from('daily_matches').upsert(formattedMatches, { onConflict: 'id' });
            if (insErr) {
                console.error("❌ Erè enskripsyon nan Supabase:", insErr);
            } else {
                console.log(`✅ ${formattedMatches.length} match (sou 10 jou) senkronize nan Supabase!`);
            }
        } else {
            console.log("⚠️ Pa gen okenn match pou peryòd sa a sou Football-Data.org.");
        }
    } catch (err) {
        console.error("❌ Erè nan fonksyon sync la:", err);
    }
}

async function analyzeMatch(match) {
    if (!GEMINI_KEY) {
        throw new Error('GEMINI_API_KEY pa konfigire sou sèvè a');
    }

    const prompt = `Fè yon analiz pou match foutbòl sa a: ${match.team_a} vs ${match.team_b} (${match.league_name}).
Reponn SÈLMAN ak yon objè JSON valid nan fòma sa a ekzakteman (pa koupe l, pa ajoute tèks deyò a):
{
  "pronostik": [{"label": "Viktwa ${match.team_a}", "confidence": 82, "risk": "Fèb"}, {"label": "Plis 2.5 Bi", "confidence": 78, "risk": "Fèb"}, {"label": "BTTS", "confidence": 70, "risk": "Modere"}],
  "analiz_ia": "yon paragraf kout an Kreyòl ki eksplike tandans prensipal la",
  "bilan": {"home": {"win":0,"draw":0,"loss":0}, "away": {"win":0,"draw":0,"loss":0}},
  "forme": {"home": ["W","W","D","W","L"], "away": ["W","D","L","W","W"]},
  "h2h": [{"result": "${match.team_a} 2 - 1 ${match.team_b}", "date": "dat"}],
  "absences": {"home": [{"name":"Okenn", "status":"bon"}], "away": [{"name":"Okenn", "status":"bon"}]},
  "lineup": {
    "home": {"formation":"4-3-3", "gk":["GK"], "df":["DF1","DF2","DF3","DF4"], "mid":["M1","M2","M3"], "fw":["F1","F2","F3"]},
    "away": {"formation":"4-3-3", "gk":["GK"], "df":["DF1","DF2","DF3","DF4"], "mid":["M1","M2","M3"], "fw":["F1","F2","F3"]}
  },
  "recommendation": "yon fraz kout"
}`;

    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${GEMINI_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'gemini-3.5-flash',
            messages: [{ role: 'user', content: prompt }],
            response_format: { type: "json_object" },
            max_tokens: 100000
        })
    });

    const data = await res.json();

    if (!res.ok) {
        throw new Error(`Gemini HTTP ${res.status}: ${data.error?.message || JSON.stringify(data)}`);
    }

    let rawText = data.choices?.[0]?.message?.content || '';
    if (!rawText) {
        throw new Error(`Gemini pa retounen tèks: ${JSON.stringify(data)}`);
    }

    rawText = rawText.replace(/```json|```/g, '').trim();

    try {
        return JSON.parse(rawText);
    } catch (e) {
        throw new Error(`JSON envalid soti nan modèl la: ${rawText.substring(0, 150)}...`);
    }
}

// 2. SÈLMAN analize match jodi a, demen, ak apre demen!
async function generatePendingAnalysis() {
    console.log('🧠 Chèche match ki bezwen analiz (Sèlman pou jodi a ak 2 jou apre)...');

    const todayDate = new Date();
    const maxDate = new Date();
    maxDate.setDate(todayDate.getDate() + 2); // Jodi a + 2 jou apre (antou 3 jou)

    const todayStr = todayDate.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const maxDateStr = maxDate.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    const { data: pending, error } = await supabase
        .from('daily_matches')
        .select('*')
        .is('percent', null)
        .gte('match_date', todayStr)
        .lte('match_date', maxDateStr)
        .limit(10);

    if (error) { console.error('❌ Erè chèche match pou analize:', error); return; }
    if (!pending || pending.length === 0) { console.log('✅ Pa gen okenn match ki bezwen analiz nan fenèt 3 jou sa yo.'); return; }

    console.log(`🧠 ${pending.length} match pou analize nan fenèt 3 jou sa yo...`);

    for (const match of pending) {
        try {
            const parsed = await analyzeMatch(match);
            const topPick = parsed.pronostik?.[0];

            await supabase.from('match_analysis').upsert({
                match_id: match.id,
                data: parsed,
                created_at: new Date().toISOString()
            });

            await supabase.from('daily_matches').update({
                percent: topPick ? `${topPick.confidence}%` : 'N/A',
                victory: topPick ? topPick.label : 'Analiz endisponib'
            }).eq('id', match.id);

            console.log(`✅ Analize: ${match.team_a} vs ${match.team_b} (${match.match_date})`);

            // Poz 4 segonn pou respekte limit API a
            await sleep(4000);

        } catch (err) {
            console.error(`❌ Erè analiz pou ${match.team_a} vs ${match.team_b}:`, err.message);
        }
    }
}

app.use(express.json());

app.get('/', (req, res) => {
    res.send('BETZONE Backend active');
});

app.get('/api/match-details/:matchId', async (req, res) => {
    const matchId = req.params.matchId;

    try {
        const { data: cached } = await supabase
            .from('match_analysis')
            .select('data, created_at')
            .eq('match_id', matchId)
            .maybeSingle();

        const isSameDay = cached && (new Date(cached.created_at).toDateString() === new Date().toDateString());
        if (isSameDay) {
            return res.json({ ...cached.data, cached: true });
        }

        const { data: match, error: matchErr } = await supabase
            .from('daily_matches')
            .select('*')
            .eq('id', matchId)
            .single();

        if (matchErr || !match) {
            return res.status(404).json({ error: 'Match pa jwenn' });
        }

        const parsed = await analyzeMatch(match);

        await supabase.from('match_analysis').upsert({
            match_id: matchId,
            data: parsed,
            created_at: new Date().toISOString()
        });

        return res.json({ ...parsed, cached: false });

    } catch (err) {
        console.error('❌ Erè match-details:', err);
        return res.status(500).json({ error: 'Nou pa t ka jenere analiz la kounye a.' });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Sèvè ap koute sou pò ${PORT}`);
    syncDailyMatches().then(() => generatePendingAnalysis());

    // Kouri otomatik chak jou presizeman a 2:00 AM (lè Nouyòk / Ayiti)
    cron.schedule('0 2 * * *', async () => {
        console.log('⏰ Ekzekisyon otomatik 2:00 AM kòmanse...');
        await syncDailyMatches();
        await generatePendingAnalysis();
    }, {
        scheduled: true,
        timezone: "America/New_York"
    });
});