const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');

const app = express();

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

app.use(express.json());

const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://uiepdartkcunumajlwwg.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'sb_secret_QkRjPE0nGdy5Y74SOAaoDw_BUrAn7ju';
const GEMINI_KEY = process.env.GEMINI_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const SPORTSDB_API_KEY = '3';
const BASE_URL = `https://www.thesportsdb.com/api/v1/json/${SPORTSDB_API_KEY}`;

const LEAGUES = [
    { id: '4328', code: 'PL', name: 'English Premier League' },
    { id: '4335', code: 'PD', name: 'Spanish La Liga' },
    { id: '4331', code: 'BL1', name: 'German Bundesliga' },
    { id: '4334', code: 'FL1', name: 'French Ligue 1' },
    { id: '4332', code: 'SA', name: 'Italian Serie A' },
    { id: '4480', code: 'CL', name: 'UEFA Champions League' }
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper pou evite erè JSON ki plante sèvè a
async function fetchSafeJSON(url) {
    try {
        const res = await fetch(url);
        if (!res.ok) {
            console.error(`⚠️ HTTP Erè ${res.status} sou URL: ${url}`);
            return null;
        }
        const text = await res.text();
        if (!text || text.trim() === '') return null;
        return JSON.parse(text);
    } catch (err) {
        console.error(`❌ Erè parsing JSON sou ${url}:`, err.message);
        return null;
    }
}

// 1. Senkronize match
async function syncDailyMatches() {
    console.log(`⏰ [${new Date().toISOString()}] Ekzekisyon senkronizasyon match...`);

    const todayDate = new Date();
    const maxDate = new Date();
    maxDate.setDate(todayDate.getDate() + 10);

    const todayStr = todayDate.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const maxStr = maxDate.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    for (const league of LEAGUES) {
        try {
            // Chèche match pou pwochen jou yo ak TheSportsDB
            const eventsData = await fetchSafeJSON(`${BASE_URL}/eventsnext.php?id=${league.id}`);
            let allEvents = eventsData && eventsData.events ? eventsData.events : [];

            // Chèche match jodi a tou pou sekirite
            const todayData = await fetchSafeJSON(`${BASE_URL}/eventsday.php?d=${todayStr}&l=${encodeURIComponent(league.name)}`);
            if (todayData && todayData.events) {
                allEvents = [...allEvents, ...todayData.events];
            }

            if (allEvents.length === 0) {
                console.log(`⚠️ Pa gen done disponib pou ${league.name} kounye a.`);
                continue;
            }

            const uniqueEventsMap = new Map();
            allEvents.forEach(e => {
                if (e && e.idEvent) uniqueEventsMap.set(e.idEvent, e);
            });
            const uniqueEvents = Array.from(uniqueEventsMap.values());

            const validMatches = uniqueEvents.filter(event => {
                const eventDate = event.dateEvent;
                return eventDate && eventDate >= todayStr && eventDate <= maxStr;
            });

            if (validMatches.length === 0) {
                console.log(`⚠️ Pa gen match ant ${todayStr} ak ${maxStr} pou ${league.name}.`);
                continue;
            }

            console.log(`⚽ Jwenn ${validMatches.length} match pou ${league.name}.`);

            const { data: existingMatches } = await supabase.from('daily_matches').select('id, victory, percent');
            const existingMap = new Map(existingMatches?.map(m => [m.id, m]) || []);

            const formattedMatches = validMatches.map(event => {
                const matchId = parseInt(event.idEvent);
                const existing = existingMap.get(matchId);

                return {
                    id: matchId,
                    league_code: league.code,
                    league_name: league.name,
                    match_date: event.dateEvent,
                    match_time: event.strTime ? event.strTime.substring(0, 5) : '20:00',
                    team_a: event.strHomeTeam,
                    team_b: event.strAwayTeam,
                    victory: existing ? existing.victory : null,
                    percent: existing ? existing.percent : null
                };
            });

            const { error: insErr } = await supabase.from('daily_matches').upsert(formattedMatches, { onConflict: 'id' });

            if (insErr) {
                console.error(`❌ Erè Supabase pou ${league.name}:`, insErr.message);
            } else {
                console.log(`✅ ${formattedMatches.length} match senkronize pou ${league.name}!`);
            }

            await sleep(1500);

        } catch (err) {
            console.error(`❌ Erè senkronizasyon pou ${league.name}:`, err.message);
        }
    }
}

// 2. Analiz ak Gemini
async function analyzeMatch(match) {
    if (!GEMINI_KEY) {
        throw new Error('GEMINI_API_KEY pa konfigire sou sèvè a');
    }

    const prompt = `Fè yon rechèch REYÈL sou entènèt pou match foutbòl sa a: ${match.team_a} vs ${match.team_b} (${match.league_name}).

RÈG SOUS POU CHAK SEKSYON (obligatwa, swiv yo egzakteman):
1. "pronostik": Chèche VRÈ pronostik ki pibliye sou site BETMINES pou match sa a (Home Win %, Draw %, Over/Under, BTTS...). Itilize done sa yo pou ranpli "confidence" ak "risk" — pa envante yo, itilize sa BetMines pibliye reyèlman.
2. "analiz_ia": Se PWÒP DEDIKSYON pa ou (AI a) — baze sou rechèch ou fè sou FÒM RESAN tou de ekip yo (dènye match yo, dinamik aktyèl). Ekri yon paragraf ki eksplike konklizyon pa ou.
3. "forme": Chèche 5 dènye rezilta chak ekip SOU SITE BETMINES.
4. "h2h": Chèche 5 dènye match ant de ekip yo SOU SITE BETMINES.
5. "absences": Chèche jwè blese oswa sispann ki pp jwe match sa pou toude ekip yo SOU GOOGLE.
6. "lineup": PA kopye yon konpozisyon deja pibliye — DEDUI li pa ou menm: chèche SOU GOOGLE ki 11 jwè ki te kòmanse (starting XI) nan 2 DÈNYE match chak ekip te jwe, epi konstwi yon konpozisyon pwobab apati sa.
"bilan": baze sou estatistik sezon aktyèl yo, chèche sou site BetMines tou.

Reponn SÈLMAN ak yon objè JSON valid (san okenn tèks anplis, san eksplikasyon), ki swiv EGZAKTEMAN estrikti sa a:
{
  "pronostik": [{"label": "<pick BetMines>", "confidence": 80, "risk": "Fèb"}, {"label": "<2yèm pick>", "confidence": 70, "risk": "Modere"}, {"label": "<3yèm pick>", "confidence": 60, "risk": "Elve"}],
  "analiz_ia": "<paragraf dediksyon pa ou, baze sou fòm resan>",
  "bilan": {"home": {"win":0,"draw":0,"loss":0}, "away": {"win":0,"draw":0,"loss":0}},
  "forme": {"home": ["W","W","D","L","W"], "away": ["W","D","L","W","W"]},
  "h2h": [{"result": "<vrè rezilta>", "date": "<vrè dat>"}],
  "absences": {"home": [{"name":"<non jwè>", "status":"<blese/sispann>"}], "away": [{"name":"<non>", "status":"<...>"}]},
  "lineup": {
    "home": {"formation":"4-3-3", "gk":["<non>"], "df":["<4 non>"], "mid":["<3 non>"], "fw":["<3 non>"]},
    "away": {"formation":"4-3-3", "gk":["<non>"], "df":["<4 non>"], "mid":["<3 non>"], "fw":["<3 non>"]}
  },
  "recommendation": "<konklizyon kout pa ou>"
}`;

    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${GEMINI_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'gemini-2.5-flash-lite',
            messages: [{ role: 'user', content: prompt }],
            response_format: { type: "json_object" },
            max_tokens: 4000
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

    syncDailyMatches();

    cron.schedule('0 2 * * *', async () => {
        console.log('⏰ Ekzekisyon otomatik 2:00 AM kòmanse...');
        await syncDailyMatches();
    }, {
        scheduled: true,
        timezone: "America/New_York"
    });
});