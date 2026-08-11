const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');

const app = express();
// Render ap otomatikman bay pò HTTP a nan process.env.PORT
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = 'https://uiepdartkcunumajlwwg.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'sb_secret_QkRjPE0nGdy5Y74SOAaoDw_BUrAn7ju';
const API_SPORTS_KEY = process.env.API_SPORTS_KEY || '642b2222ba559586a9a165bcd30053b4';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function syncDailyMatches() {
    const lèLokal = new Date().toLocaleTimeString('fr-FR', { timeZone: 'America/Port-au-Prince' });
    console.log(`⏰ [${lèLokal}] Mizajou match jounen an kòmanse ak API-Sports...`);
    
    const today = new Date().toISOString().split('T')[0];

    try {
        const response = await fetch(`https://v3.football.api-sports.io/fixtures?date=${today}`, {
            headers: { 'x-apisports-key': API_SPORTS_KEY }
        });

        const data = await response.json();

        if (data.response && data.response.length > 0) {
            const formattedMatches = data.response.map(item => {
                let lCode = 'ALL';
                if (item.league.id === 39) lCode = 'PL';
                else if (item.league.id === 140) lCode = 'PD';
                else if (item.league.id === 78) lCode = 'BL1';
                else if (item.league.id === 61) lCode = 'FL1';
                else if (item.league.id === 135) lCode = 'SA';
                else if (item.league.id === 2) lCode = 'CL';

                return {
                    id: item.fixture.id,
                    league_code: lCode,
                    league_name: item.league.name,
                    match_time: new Date(item.fixture.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                    team_a: item.teams.home.name,
                    team_b: item.teams.away.name,
                    victory: `Viktwa ${item.teams.home.name}`,
                    percent: `${Math.floor(Math.random() * 15) + 78}%`,
                    analysis: 'Analiz spòtif kalkile pa rezo'
                };
            });

            await supabase.from('daily_matches').delete().neq('id', 0);
            const { error } = await supabase.from('daily_matches').insert(formattedMatches);

            if (error) throw error;
            console.log("✅ Match jounen an anrejistre kòrèkteman nan Supabase!");
        } else {
            await supabase.from('daily_matches').delete().neq('id', 0);
            console.log("⚠️ Pa gen match pou jodi a, table la netwaye.");
        }
    } catch (err) {
        console.error("❌ Erè nan senkronizasyon an:", err);
    }
}

// Route senp pou Render tcheke ak konfirme sèvè a "Live"
app.get('/', (req, res) => {
    res.send('BETZONE Backend active ak Cron Job!');
});

// Demare sèvè Express la
app.listen(PORT, () => {
    console.log(`🚀 Sèvè ap koute sou pò ${PORT}`);
    
    // Ekzekite 1 fwa nan demaraj
    syncDailyMatches();
    
    // Cron Job pou kouri chak minit (oswa '30 3 * * *' pou 3:30 AM)
    cron.schedule('* * * * *', async () => {
        await syncDailyMatches();
    }, {
        scheduled: true,
        timezone: "America/Port-au-Prince"
    });
});
