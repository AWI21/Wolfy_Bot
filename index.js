require('dotenv').config();
const { deployCommands } = require('./deployCommands');
const { startBot } = require('./src/bot');
const { startWebServer } = require('./src/web/server');
const registerAdvancedLogs = require('./src/utils/advancedLogs.js');
const { flushXP } = require('./src/systems/leveling');

// Odpal rejestrację w tle – nie blokuje logowania bota
deployCommands().catch(err => console.error('Błąd rejestracji komend:', err));

let client = null;

async function init() {
    try {
        console.log("Starting AWI Bot...");

        await startWebServer();

        client = await startBot();

        if (client) {
            registerAdvancedLogs(client);
        } else {
            console.error('❌ startBot() did not return a client instance — skipping advancedLogs registration.');
        }

    } catch (error) {
        console.error("❌ Failed to start:", error);
    }
}

const handleShutdown = async (signal) => {
    console.log(`Received ${signal}. Powering down instance...`);
    try {
        await flushXP();
    } catch (err) {
        console.error('Error flushing pending XP on shutdown:', err);
    }
    if (client) {
        try {
            await client.destroy();
        } catch (err) {
            console.error('Error destroying client:', err);
        }
    }
    process.exit(0);
};

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

init();