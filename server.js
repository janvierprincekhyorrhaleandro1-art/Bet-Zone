const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const axios = require('axios');

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
const BAZAARLINK_KEY = process.env.BAZAARLINK_API_KEY;
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY || 'VOTRE_API_FOOTBALL_KEY';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ID Numeryik API-FOOTBALL pou gwo lig yo
const TARGET_LEAGUES = {
    39: { code: 'PL', name: 'English Premier League' },
    140: { code: 'PD', name: 'Spanish La Liga' },
    78: { code: 'BL1', name: 'German Bundesliga' },
    61: { code: 'FL1', name: 'French Ligue 1' },
    135: { code: 'SA', name: 'Italian Serie A' },
    2: { code: 'CL', name: 'UEFA Champions League' }
};

// Fonksyon pou jwenn dat "YYYY-MM-DD" nan timezone lokal Nouyòk/Ayiti
function getLocalDateString(offsetDays = 0) {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(d);
}

function getCrestUrl(teamId, teamName) {
    if (teamId) {
        return `https://media.api-sports.io/football/teams/${teamId}.png`;
    }
    return `https://ui-avatars.com/api/?name=${encodeURIComponent(teamName || 'Team')}&background=10b981&color=fff`;
}

// 1. Senkronizasyon Match soti nan -1 Jou (Yè) jiska +4 Jou apre jodia
async function syncDailyMatches() {
    console.log(`⏰ [${new Date().toISOString()}] Senkronizasyon match kòmanse (yè [-1] jiska 4 jou apre [+4])...`);
    
    let allFormattedMatches = [];

    // Loop soti nan -1 jou (yè) pou rive +4 jou apre jodia
    for (let i = -1; i <= 4; i++) {
        const dateStr = getLocalDateString(i);

        try {
            const response = await axios.get(`https://v3.football.api-sports.io/fixtures?date=${dateStr}`, {
                headers: { 'x-apisports-key': API_FOOTBALL_KEY }
            });

            const dayMatches = response.data?.response || [];
            
            // Filtre match yo pa lig nou konsène yo
            const filteredMatches = dayMatches.filter(m => TARGET_LEAGUES[m.league.id]);

            console.log(`📅 Dat: ${dateStr} (i=${i}) | Match API: ${dayMatches.length} | Match nan Lig nou yo: ${filteredMatches.length}`);

            const formatted = filteredMatches.map(m => {
                const leagueInfo = TARGET_LEAGUES[m.league.id];
                const statusShort = m.fixture.status?.short || 'NS';
                
                return {
                    id: m.fixture.id,
                    league_code: leagueInfo.code,
                    league_name: leagueInfo.name,
                    match_date: m.fixture.date.split('T')[0],
                    match_time: new Date(m.fixture.date).toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }),
                    team_a: m.teams.home.name,
                    team_b: m.teams.away.name,
                    team_a_id: m.teams.home.id,
                    team_b_id: m.teams.away.id,
                    home_score: m.goals.home,
                    away_score: m.goals.away,
                    status: (statusShort === 'FT' || statusShort === 'AET' || statusShort === 'PEN') ? 'FINI' : (statusShort === '1H' || statusShort === '2H' || statusShort === 'HT') ? 'LIVE' : 'ANNATANT'
                };
            });

            allFormattedMatches.push(...formatted);

        } catch (err) {
            console.error(`❌ Erè nan rale dat ${dateStr}:`, err.message);
        }
    }

    if (allFormattedMatches.length > 0) {
        const { error: upsertErr } = await supabase.from('daily_matches').upsert(allFormattedMatches, { onConflict: 'id' });
        if (upsertErr) {
            console.error('❌ Erè ensèsyon Supabase:', upsertErr.message);
        } else {
            console.log(`✅ Total ${allFormattedMatches.length} match senkronize ak siksè nan Supabase!`);
        }
    } else {
        console.log('ℹ️ Pa gen match pou lig sa yo nan entèval dat sa a.');
    }
}

// 2. Rale Prediksyon Nèt nan API-FOOTBALL
async function getApiFootballPrediction(fixtureId) {
    try {
        const res = await axios.get(`https://v3.football.api-sports.io/predictions?fixture=${fixtureId}`, {
            headers: { 'x-apisports-key': API_FOOTBALL_KEY }
        });

        const item = res.data?.response?.[0];
        if (!item) return null;

        const h2h = (item.h2h || []).slice(0, 5).map(m => ({
            result: `${m.teams.home.name} ${m.goals.home ?? 0} - ${m.goals.away ?? 0} ${m.teams.away.name}`,
            date: m.fixture.date.split('T')[0]
        }));

        return {
            rawPred: item.predictions,
            teams: item.teams,
            h2h: h2h,
            forme: {
                home: item.teams.home.league.form ? item.teams.home.league.form.split('').slice(-5) : ['N','N','N','N','N'],
                away: item.teams.away.league.form ? item.teams.away.league.form.split('').slice(-5) : ['N','N','N','N','N']
            }
        };
    } catch (e) {
        console.error('❌ Erè API-FOOTBALL Prediction:', e.message);
        return null;
    }
}

// 3. AI Sèlman Fè Kout Analiz la an Kreyòl
async function generateShortAnalysis(match, apiData) {
    if (!BAZAARLINK_KEY || !apiData) {
        return "Analiz taktik: De ekip yo ap rantre nan match sa a ak anpil motivasyon pou yo ka pran 3 pwen yo.";
    }

    const prompt = `
Ou se yon ekspè analiz espòtif. Fè yon KOUT ANALIZ (2 jiska 3 fraz maksimòm) an Kreyòl Ayisyen pou match sa a: ${match.team_a} vs ${match.team_b}.

Mwen ba ou done sa yo:
- Konsèy Prediksyon: ${apiData.rawPred?.advice || 'Match la ap trè sere'}
- Pousantaj Viktwa: Lakay (${apiData.rawPred?.percent?.home}), Nul (${apiData.rawPred?.percent?.draw}), Deyò (${apiData.rawPred?.percent?.away})
- Ekip ki an avantaaj: ${apiData.rawPred?.winner?.name || 'Okenn'}

RÈG STRICT:
1. PA MENSYONE okenn non API, okenn sit entènèt, ni kote done yo soti (PA di "API-FOOTBALL", "daprè done yo", oswa "daprè sous la").
2. Pale dirèkteman de fòm ekip yo ak chans yo genyen pou yo bat oswa fè gòl nan match la.
3. Reponn ak TÈKS SÈLMAN (pa gen JSON, pa gen markdown).`;

    try {
        const response = await axios.post('https://bazaarlink.ai/api/v1/chat/completions', {
            model: 'auto:free',
            messages: [{ role: 'user', content: prompt }]
        }, {
            headers: {
                'Authorization': `Bearer ${BAZAARLINK_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        return response.data?.choices?.[0]?.message?.content?.trim() || "Match sa a ap trè sere ant de ekip yo daprè fòm yo montre nan dènye soti yo.";
    } catch (err) {
        console.error('⚠️ Erè Bazaarlink:', err.message);
        return "De ekip sa yo ap chèche reprezante yon bon nivo jwèt pou yo ka rache viktwa a jodi a.";
    }
}

// 4. Endpoint Detay Match (Avèk kontwòl strik sou prediksyon pou match ki pase deja)
app.get('/api/match-details/:matchId', async (req, res) => {
    const matchId = req.params.matchId;

    try {
        // Tcheke si analiz la te sove deja anvan nan kach la
        const { data: cached } = await supabase
            .from('match_analysis')
            .select('data, created_at')
            .eq('match_id', matchId)
            .maybeSingle();

        const { data: match } = await supabase
            .from('daily_matches')
            .select('*')
            .eq('id', matchId)
            .single();

        if (!match) {
            return res.status(404).json({ error: 'Match pa jwenn' });
        }

        const isMatchStartedOrFinished = match.status === 'FINI' || match.status === 'LIVE';

        // Si match la pase deja OUBYEN l ap jwe epi nou TE GENTAN gen yon prediksyon sove pou li avan
        if (cached && cached.data) {
            // Mettre à jour sèlman sikonstans match la (jis pou score ak status la reste à jour)
            cached.data.matchInfo.status = match.status;
            cached.data.matchInfo.homeScore = match.home_score ?? null;
            cached.data.matchInfo.awayScore = match.away_score ?? null;
            
            console.log(`⚡ Match ${matchId} retounen ak ansyen prediksyon kach li a.`);
            return res.json({ ...cached.data, cached: true });
        }

        // Si match la pase deja (FINI/LIVE) epi l PAT gentan gen yon prediksyon sove:
        // Nou p ap rele API pou fè prediksyon pou li kounye a paske match sa pase deja!
        if (isMatchStartedOrFinished) {
            const homeLogo = getCrestUrl(match.team_a_id, match.team_a);
            const awayLogo = getCrestUrl(match.team_b_id, match.team_b);

            const pastMatchResponse = {
                matchInfo: {
                    league: match.league_name,
                    status: match.status,
                    date: match.match_date,
                    homeName: match.team_a,
                    awayName: match.team_b,
                    homeLogo: homeLogo,
                    awayLogo: awayLogo,
                    homeScore: match.home_score ?? null,
                    awayScore: match.away_score ?? null
                },
                pronostik: [], // Okenn nouvo prediksyon paske match la jwe deja
                analiz_ia: "Match sa a jwe deja. Yo pa ka bay prediksyon pou yon match ki te fini oswa k ap jwe an tan reyèl.",
                bilan: { home: { win: 0, draw: 0, loss: 0 }, away: { win: 0, draw: 0, loss: 0 } },
                forme: { home: ['N','N','N','N','N'], away: ['N','N','N','N','N'] },
                h2h: [],
                absences: { home: [], away: [] },
                recommendation: "Match sa a jwe deja."
            };

            return res.json({ ...pastMatchResponse, cached: false });
        }

        // Si match la se yon match k ap vini (ANNATANT) epi li poko gen kach
        const apiData = await getApiFootballPrediction(matchId);

        let pronostik = [];
        let recommendation = "Match sa a sanble balanse.";
        let analiz_ia = "Analiz taktik: De ekip yo ap rantre nan match sa a ak anpil motivasyon.";

        if (apiData && apiData.rawPred) {
            const p = apiData.rawPred;
            const homePercent = parseInt(p.percent.home) || 0;
            const awayPercent = parseInt(p.percent.away) || 0;

            const bestWinTeam = homePercent >= awayPercent ? match.team_a : match.team_b;
            const bestWinConfidence = Math.max(homePercent, awayPercent);

            pronostik = [
                {
                    label: `${bestWinTeam} Win / Draw`,
                    confidence: bestWinConfidence,
                    risk: bestWinConfidence > 60 ? "Fèb" : "Modere"
                },
                {
                    label: p.advice || "Over 1.5 Goals",
                    confidence: 70,
                    risk: "Modere"
                }
            ];

            recommendation = p.advice ? `Opsyon ki pi sekirize: ${p.advice}` : recommendation;
            analiz_ia = await generateShortAnalysis(match, apiData);
        }

        const homeLogo = getCrestUrl(match.team_a_id, match.team_a);
        const awayLogo = getCrestUrl(match.team_b_id, match.team_b);

        const finalResponse = {
            matchInfo: {
                league: match.league_name,
                status: match.status || 'ANNATANT',
                date: match.match_date,
                homeName: match.team_a,
                awayName: match.team_b,
                homeLogo: homeLogo,
                awayLogo: awayLogo,
                homeScore: match.home_score ?? null,
                awayScore: match.away_score ?? null
            },
            pronostik: pronostik,
            analiz_ia: analiz_ia,
            bilan: { home: { win: 0, draw: 0, loss: 0 }, away: { win: 0, draw: 0, loss: 0 } },
            forme: apiData ? apiData.forme : { home: ['N','N','N','N','N'], away: ['N','N','N','N','N'] },
            h2h: apiData ? apiData.h2h : [],
            absences: { home: [], away: [] },
            recommendation: recommendation
        };

        // Sove done prediksyon an nan Supabase pou li ka rete fiks menm lè match la vini ap jwe oswa fini pita
        await supabase.from('match_analysis').upsert({
            match_id: matchId,
            data: finalResponse,
            created_at: new Date().toISOString()
        });

        return res.json({ ...finalResponse, cached: false });

    } catch (err) {
        console.error('❌ Erè match-details:', err);
        return res.status(500).json({ error: err.message });
    }
});

// Cron Kouri 2:00 AM Chak Jou
cron.schedule('0 2 * * *', async () => {
    console.log('⏰ Otomatisasyon cron kòmanse (2:00 AM)...');
    await syncDailyMatches();
});

syncDailyMatches();

app.listen(PORT, () => console.log(`🚀 Sèvè ap koute sou pò ${PORT}`));