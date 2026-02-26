#!/usr/bin/env node

/**
 * Discord Slash Command Deployment Script
 * 
 * Usage:
 *   node discord/deploy-commands.js              # Deploy globally (takes up to 1 hour)
 *   node discord/deploy-commands.js --guild      # Deploy to specific guild (instant)
 *   node discord/deploy-commands.js --clear      # Clear all commands
 * 
 * Note: Global commands are cached for up to 1 hour. Use --guild for testing.
 */

const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

require('dotenv').config();

const token = process.env.DISCORD_BOT_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token) {
  console.error('❌ DISCORD_BOT_TOKEN not found in .env');
  process.exit(1);
}

// Extract client ID from token if not provided
const extractedClientId = token.split('.')[0];
const finalClientId = clientId || extractedClientId;

const args = process.argv.slice(2);
const isGlobal = !args.includes('--guild');
const isClear = args.includes('--clear');

const rest = new REST({ version: '10' }).setToken(token);

function loadCommands() {
  const commandsDir = path.join(__dirname, 'commands');
  const commands = [];
  
  if (!fs.existsSync(commandsDir)) {
    console.log('⚠️  Commands directory not found');
    return commands;
  }

  const commandFiles = fs.readdirSync(commandsDir).filter(file => file.endsWith('.js'));

  for (const file of commandFiles) {
    try {
      const command = require(path.join(commandsDir, file));
      if (command.data) {
        commands.push(command.data.toJSON());
        console.log(`📋 Loaded: ${command.data.name}`);
      }
    } catch (error) {
      console.error(`❌ Failed to load ${file}:`, error.message);
    }
  }

  return commands;
}

async function deployCommands() {
  try {
    if (isClear) {
      console.log('🗑️  Clearing slash commands...');
      
      if (guildId) {
        await rest.put(
          Routes.applicationGuildCommands(finalClientId, guildId),
          { body: [] }
        );
        console.log('✅ Guild commands cleared');
      }
      
      await rest.put(
        Routes.applicationCommands(finalClientId),
        { body: [] }
      );
      console.log('✅ Global commands cleared');
      return;
    }

    console.log('📂 Loading commands...');
    const commands = loadCommands();
    
    if (commands.length === 0) {
      console.error('❌ No commands found to deploy');
      process.exit(1);
    }
    
    console.log(`\n🚀 Deploying ${commands.length} slash commands...`);

    if (isGlobal) {
      // Global commands - available in all servers, cached up to 1 hour
      console.log('⏳ Deploying globally (may take up to 1 hour to appear)...');
      const data = await rest.put(
        Routes.applicationCommands(finalClientId),
        { body: commands }
      );
      console.log(`✅ Successfully deployed ${data.length} global commands`);
    } else if (guildId) {
      // Guild-specific commands - instant, for testing
      console.log(`⏳ Deploying to guild ${guildId}...`);
      const data = await rest.put(
        Routes.applicationGuildCommands(finalClientId, guildId),
        { body: commands }
      );
      console.log(`✅ Successfully deployed ${data.length} guild commands`);
    } else {
      console.error('❌ --guild flag requires DISCORD_GUILD_ID in .env');
      console.log('💡 Tip: Use global deployment or set DISCORD_GUILD_ID');
      process.exit(1);
    }

    console.log('\n📋 Next steps:');
    console.log('   1. Invite bot to your server with applications.commands scope');
    console.log('   2. Type / to see the commands');
    console.log('   3. Run the bot: node discord/index.js');
    
  } catch (error) {
    console.error('❌ Deployment failed:', error.message);
    if (error.message.includes('401')) {
      console.log('\n💡 Check your DISCORD_BOT_TOKEN is valid');
    }
    if (error.message.includes('404')) {
      console.log('\n💡 Check your DISCORD_CLIENT_ID is correct');
    }
    process.exit(1);
  }
}

deployCommands();
