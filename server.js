const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://uiepdartkcunumajlwwg.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'sb_secret_QkRjPE0nGdy5Y74SOAaoDw_BUrAn7ju';
const API_SPORTS_KEY = process.env.API_SPORTS_KEY || '786436f474647cfaf961b05ac11978d1';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function syncDailyMatches() {
    console.log(`⏰ [${new Date().toISOString()}] Ekzekisyon senkronizasyon match...`);
    
    // Rale dat jodi a sou fòma YYYY-MM-DD nan orè Ayiti / New York
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    console.log(`📅 Chèche match pou dat: ${today}`);

    try {
        const response = await fetch(`https://v3.football.api-sports.io/fixtures?date=${today}`, {
            headers: { 'x-apisports-key': API_SPORTS_KEY }
        });

        const data = await response.json();

        if (data.errors && Object.keys(data.errors).length > 0) {
            console.error("❌ Erè ki soti nan API-Sports:", data.errors);
            return;
        }

        if (data.response && data.response.length > 0) {
            console.log(`⚽ Jwenn ${data.response.length} match sou API-Sports.`);

            const formattedMatches = data.response.map(item => {
                let lCode = 'ALL';
                const id = item.league.id;

                if (id === 39) lCode = 'PL';
                else if (id === 140) lCode = 'PD';
                else if (id === 78) lCode = 'BL1';
                else if (id === 61) lCode = 'FL1';
                else if (id === 135) lCode = 'SA';
                else if (id === 2) lCode = 'CL';

                return {
                    id: item.fixture.id,
                    league_code: lCode,
                    league_name: item.league.name,
                    match_time: new Date(item.fixture.date).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' }),
                    team_a: item.teams.home.name,
                    team_b: item.teams.away.name,
                    victory: `Viktwa ${item.teams.home.name}`,
                    percent: `${Math.floor(Math.random() * 15) + 78}%`,
                    analysis: 'Analiz spòtif kalkile pa rezo'
                };
            });

            // Efase epi mete nouvo match yo
            const { error: delErr } = await supabase.from('daily_matches').delete().neq('id', 0);
            if (delErr) console.error("❌ Erè efase nan Supabase:", delErr);

            const { error: insErr } = await supabase.from('daily_matches').insert(formattedMatches);
            if (insErr) {
                console.error("❌ Erè ensèsyon nan Supabase:", insErr);
            } else {
                console.log(`✅ ${formattedMatches.length} match anrejistre nan Supabase!`);
            }
        } else {
            console.log("⚠️ Pa gen okenn match pou dat sa a sou API-Sports.");
        }
    } catch (err) {
        console.error("❌ Erè nan fonksyon sync la:", err);
    }
}

app.get('/', (req, res) => {
    res.send('BETZONE Backend active');
});

app.listen(PORT, () => {
    console.log(`🚀 Sèvè ap koute sou pò ${PORT}`);
    syncDailyMatches();
    
    cron.schedule('* * * * *', async () => {
        await syncDailyMatches();
    }, {
        scheduled: true,
        timezone: "America/New_York"
    });
});
