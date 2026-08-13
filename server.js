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

async function syncDailyMatches() {
    console.log(`⏰ [${new Date().toISOString()}] Ekzekisyon senkronizasyon match...`);

    const todayDate = new Date();
    const futureDate = new Date();
    futureDate.setDate(todayDate.getDate() + 10);

    const today = todayDate.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const toDateStr = futureDate.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    console.log(`📅 Chèche match ant: ${today} ak ${toDateStr}`);

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

            const formattedMatches = data.matches.map(item => {
                const code = item.competition.code || 'ALL';
                const realMatchDate = item.utcDate ? item.utcDate.split('T')[0] : today;

                return {
                    id: item.id,
                    league_code: code,
                    league_name: item.competition.name,
                    match_date: realMatchDate,
                    match_time: new Date(item.utcDate).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' }),
                    team_a: item.homeTeam.name,
                    team_b: item.awayTeam.name,
                    victory: null,
                    percent: null,
                    analysis: null
                };
            });

            const { error: delErr } = await supabase.from('daily_matches').delete().neq('id', 0);
            if (delErr) console.error("❌ Erè efase nan Supabase:", delErr);

            const { error: insErr } = await supabase.from('daily_matches').insert(formattedMatches);
            if (insErr) {
                console.error("❌ Erè ensèsyon nan Supabase:", insErr);
            } else {
                console.log(`✅ ${formattedMatches.length} match anrejistre nan Supabase ak tout dat yo!`);
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
Reponn SÈLMAN ak yon objè JSON valid, san okenn lòt tèks, egzakteman nan fòma sa a:
{
  "pronostik": [{"label": "Viktwa ${match.team_a}", "confidence": 82, "risk": "Fèb"}, {"label": "Plis 2.5 Bi", "confidence": 78, "risk": "Fèb"}, {"label": "BTTS", "confidence": 70, "risk": "Modere"}],
  "analiz_ia": "yon paragraf kout an Kreyòl ki eksplike tandans prensipal la",
  "bilan": {"home": {"win":0,"draw":0,"loss":0}, "away": {"win":0,"draw":0,"loss":0}},
  "forme": {"home": ["W","W","D","W","L"], "away": ["W","D","L","W","W"]},
  "h2h": [{"result": "${match.team_a} 2 - 1 ${match.team_b}", "date": "dat"}],
  "absences": {"home": [{"name":"...", "status":"blese"}], "away": [{"name":"...", "status":"blese"}]},
  "lineup": {
    "home": {"formation":"4-3-3", "gk":["..."], "df":["...","...","...","..."], "mid":["...","...","..."], "fw":["...","...","..."]},
    "away": {"formation":"4-3-3", "gk":["..."], "df":["...","...","...","..."], "mid":["...","...","..."], "fw":["...","...","..."]}
  },
  "recommendation": "yon fraz kout"
}
"risk" dwe youn nan: "Fèb", "Modere", "Elve". Si w pa jwenn done presi pou yon chan, mete yon estimasyon rezonab olye ou kite l vid.`;

    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${GEMINI_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'gemini-3.5-flash',
            messages: [{ role: 'user', content: prompt }],
            response_format: { type: "json_object" }
        })
    });

    const data = await res.json();

    if (!res.ok) {
        throw new Error(`Gemini HTTP ${res.status}: ${data.error?.message || JSON.stringify(data)}`);
    }

    const rawText = data.choices?.[0]?.message?.content || '';
    if (!rawText) {
        throw new Error(`Gemini pa retounen tèks: ${JSON.stringify(data)}`);
    }

    const cleaned = rawText.replace(/```json|```/g, '').trim();
    try {
        return JSON.parse(cleaned);
    } catch (e) {
        throw new Error(`JSON envalid soti nan modèl la: ${cleaned.substring(0, 200)}`);
    }
}

async function generatePendingAnalysis() {
    console.log('🧠 Chèche match ki bezwen analiz...');

    const { data: pending, error } = await supabase
        .from('daily_matches')
        .select('*')
        .is('percent', null)
        .limit(10);

    if (error) { console.error('❌ Erè chèche match pou analize:', error); return; }
    if (!pending || pending.length === 0) { console.log('✅ Tout match deja analize.'); return; }

    console.log(`🧠 ${pending.length} match pou analize...`);

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

            console.log(`✅ Analize: ${match.team_a} vs ${match.team_b}`);

            // Poz 4 segonn pou pa depase limit 15 reket/minit Gemini an
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

    cron.schedule('*/12 * * * *', async () => {
        await syncDailyMatches();
        await generatePendingAnalysis();
    }, {
        scheduled: true,
        timezone: "America/New_York"
    });
});
