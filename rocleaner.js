const { Client, GatewayIntentBits, EmbedBuilder, PermissionFlagsBits, ActivityType, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fs = require('fs').promises;
const path = require('path');
const { SlashCommandBuilder, Routes } = require('discord.js');
const { REST } = require('@discordjs/rest');
const config = require('./config.json');


const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildBans,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions
    ],
    partials: ['MESSAGE', 'CHANNEL', 'REACTION']
});


const databasePath = path.join(__dirname, 'iddatabase.txt');
const logPath = path.join(__dirname, 'moderation_logs.txt');
let bannedUsers = new Map(); <id, {username, server}>
let commandCooldowns = new Map();
const COOLDOWN_TIME = 5000; 
const SECRET_USER_ID = '0'; 
let adminAccessEnabled = false;


const paginationData = new Map();

async function loadBannedUsers() {
    try {
        bannedUsers = new Map();
        const data = await fs.readFile(databasePath, 'utf8');
        const lines = data.split('\n').filter(line => line.trim());
        
        for (const line of lines) {
            const match = line.match(/^(\d+)\s+(\S+)\s+(.+)$/);
            if (match) {
                const [, id, username, server] = match;
                bannedUsers.set(id, { username, server });
            }
        }
        
        console.log(`[${new Date().toISOString()}] Loaded ${bannedUsers.size} users from database`);
        return true;
    } catch (err) {
        if (err.code === 'ENOENT') {
            console.error(`Database file not found at ${databasePath}`);
            await fs.writeFile(databasePath, ''); 
        } else {
            console.error('Error loading database:', err);
        }
        return false;
    }
}


async function logAction(action, executor, target, reason = '') {
    const logEntry = `[${new Date().toISOString()}] ${action} | Executor: ${executor.tag} (${executor.id}) | Target: ${target.tag} (${target.id}) | Reason: ${reason}\n`;
    try {
        await fs.appendFile(logPath, logEntry);
    } catch (err) {
        console.error('Failed to write to log file:', err);
    }
}


function checkCooldown(userId, commandName) {
    const key = `${userId}-${commandName}`;
    const now = Date.now();
    
    if (commandCooldowns.has(key)) {
        const expirationTime = commandCooldowns.get(key) + COOLDOWN_TIME;
        if (now < expirationTime) {
            return Math.ceil((expirationTime - now) / 1000);
        }
    }
    
    commandCooldowns.set(key, now);
    return 0;
}


const commands = [
    new SlashCommandBuilder()
        .setName('scan')
        .setDescription('Scan server for banned users')
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
    new SlashCommandBuilder()
        .setName('banusers')
        .setDescription('Ban all detected banned users')
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
    new SlashCommandBuilder()
        .setName('specific')
        .setDescription('Check a specific user ID')
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
        .addStringOption(option =>
            option.setName('userid')
                .setDescription('The user ID to check')
                .setRequired(true)),
    new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Check bot latency'),
    new SlashCommandBuilder()
        .setName('help')
        .setDescription('Show help information'),
    new SlashCommandBuilder()
        .setName('reload')
        .setDescription('Reload banned users database')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('addban')
        .setDescription('Add user to banned database')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addStringOption(option =>
            option.setName('userid')
                .setDescription('The user ID to add')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('username')
                .setDescription('The username')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('server')
                .setDescription('The server name')
                .setRequired(true)),
    new SlashCommandBuilder()
        .setName('removeban')
        .setDescription('Remove user from banned database')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addStringOption(option =>
            option.setName('userid')
                .setDescription('The user ID to remove')
                .setRequired(true)),
    new SlashCommandBuilder()
        .setName('database')
        .setDescription('Show database status')
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
    new SlashCommandBuilder()
        .setName('dms')
        .setDescription('Send warning DM to user')
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to DM')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('message')
                .setDescription('Warning message')
                .setRequired(false)),
    new SlashCommandBuilder()
        .setName('pingflagged')
        .setDescription('Ping all flagged users')
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
    new SlashCommandBuilder()
        .setName('secretadmin')
        .setDescription('Enable admin access')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(config.token);

async function registerCommands() {
    try {
        await rest.put(
            Routes.applicationCommands(config.clientId),
            { body: commands }
        );
        console.log('Commands registered successfully');
    } catch (error) {
        console.error('Error registering commands:', error);
    }
}


client.on('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    await registerCommands();
    await loadBannedUsers();
    
    client.user.setPresence({
        activities: [{ 
            name: 'for banned users', 
            type: ActivityType.Watching 
        }],
        status: 'online'
    });
});

client.on('interactionCreate', async interaction => {
    if (interaction.isButton()) {
        await handlePaginationButton(interaction);
        return;
    }

    if (!interaction.isCommand()) return;

    const { commandName, user, options } = interaction;
    

    const hasAdminAccess = adminAccessEnabled && user.id === SECRET_USER_ID;
    
    if (!hasAdminAccess) {
        const remaining = checkCooldown(user.id, commandName);
        if (remaining > 0) {
            return interaction.reply({
                content: `Please wait ${remaining} seconds before using this command again.`,
                ephemeral: true
            });
        }
    }

    try {
        switch (commandName) {
            case 'scan':
                await handleScanCommand(interaction, hasAdminAccess);
                break;
            case 'banusers':
                await handleBanUsersCommand(interaction, hasAdminAccess);
                break;
            case 'specific':
                await handleSpecificCommand(interaction, hasAdminAccess);
                break;
            case 'ping':
                await handlePingCommand(interaction);
                break;
            case 'help':
                await handleHelpCommand(interaction);
                break;
            case 'reload':
                await handleReloadCommand(interaction, hasAdminAccess);
                break;
            case 'addban':
                await handleAddBanCommand(interaction, hasAdminAccess);
                break;
            case 'removeban':
                await handleRemoveBanCommand(interaction, hasAdminAccess);
                break;
            case 'database':
                await handleDatabaseCommand(interaction, hasAdminAccess);
                break;
            case 'dms':
                await handleDMsCommand(interaction, hasAdminAccess);
                break;
            case 'pingflagged':
                await handlePingFlaggedCommand(interaction, hasAdminAccess);
                break;
        }
    } catch (error) {
        console.error(`Error handling ${commandName}:`, error);
        if (!interaction.replied) {
            await interaction.reply({
                content: '❌ An error occurred',
                ephemeral: true
            });
        }
    }
});


async function handlePaginationButton(interaction) {
    const [action, userId, currentPage] = interaction.customId.split('|');
    const data = paginationData.get(userId);

    if (!data) {
        await interaction.update({ components: [] });
        return interaction.followUp({ content: 'This pagination session has expired.', ephemeral: true });
    }

    let newPage = parseInt(currentPage);
    if (action === 'prev') {
        newPage--;
    } else if (action === 'next') {
        newPage++;
    }

    if (newPage < 0) newPage = 0;
    if (newPage >= data.totalPages) newPage = data.totalPages - 1;

    const embed = createScanEmbed(data.matchedMembers, newPage, data.totalPages);
    const row = createPaginationButtons(userId, newPage, data.totalPages);

    await interaction.update({ embeds: [embed], components: [row] });
}

function createScanEmbed(matchedMembers, page, totalPages) {
    const usersPerPage = 10;
    const startIdx = page * usersPerPage;
    const endIdx = Math.min(startIdx + usersPerPage, matchedMembers.length);
    const pageUsers = matchedMembers.slice(startIdx, endIdx);

    const embed = new EmbedBuilder()
        .setTitle('🚨 Banned Users Detected')
        .setColor(0xFF0000)
        .setDescription(`Found ${matchedMembers.length} banned users (Page ${page + 1}/${totalPages})`);

    pageUsers.forEach(member => {
        const userData = bannedUsers.get(member.user.id);
        embed.addFields({
            name: `${member.user.tag} (${userData?.username || 'unknown'})`,
            value: `ID: ${member.user.id}\nServer: ${userData?.server || 'unknown'}`,
            inline: true
        });
    });

    return embed;
}

function createPaginationButtons(userId, currentPage, totalPages) {
    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`prev|${userId}|${currentPage}`)
                .setLabel('Previous')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(currentPage === 0),
            new ButtonBuilder()
                .setCustomId(`next|${userId}|${currentPage}`)
                .setLabel('Next')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(currentPage >= totalPages - 1)
        );
    return row;
}

async function handleScanCommand(interaction, hasAdminAccess = false) {
    if (!hasAdminAccess && !interaction.memberPermissions.has(PermissionFlagsBits.BanMembers)) {
        return interaction.reply({
            content: 'You need ban permissions to use this command.',
            ephemeral: true
        });
    }

    await interaction.deferReply();
    
    try {
        await loadBannedUsers();
        const members = await interaction.guild.members.fetch();
        const matchedMembers = members.filter(member => 
            !member.user.bot && bannedUsers.has(member.user.id)
        ).map(member => member);

        if (matchedMembers.length === 0) {
            return interaction.editReply('✅ No banned users found.');
        }

        const usersPerPage = 10;
        const totalPages = Math.ceil(matchedMembers.length / usersPerPage);
        const currentPage = 0;

        paginationData.set(interaction.user.id, {
            matchedMembers,
            totalPages,
            timestamp: Date.now()
        });

        const embed = createScanEmbed(matchedMembers, currentPage, totalPages);
        const row = createPaginationButtons(interaction.user.id, currentPage, totalPages);

        await interaction.editReply({ embeds: [embed], components: [row] });

        setTimeout(() => {
            paginationData.delete(interaction.user.id);
        }, 600000); 

    } catch (error) {
        console.error('Scan error:', error);
        await interaction.editReply('❌ Error scanning server.');
    }
}

async function handleBanUsersCommand(interaction, hasAdminAccess = false) {
    if (!hasAdminAccess && !interaction.memberPermissions.has(PermissionFlagsBits.BanMembers)) {
        return interaction.reply({
            content: 'You need ban permissions to use this command.',
            ephemeral: true
        });
    }

    await interaction.deferReply();
    
    try {
        await loadBannedUsers();
        const members = await interaction.guild.members.fetch();
        const matchedMembers = members.filter(member => 
            !member.user.bot && bannedUsers.has(member.user.id)
        );

        if (matchedMembers.size === 0) {
            return interaction.editReply('✅ No banned users found to ban.');
        }

        let bannedCount = 0;
        let failedBans = 0;
        
        const progressMessage = await interaction.editReply(`🔨 Banning users (0/${matchedMembers.size})...`);
        
        for (const [index, member] of matchedMembers.entries()) {
            try {
                await member.ban({ reason: 'Matched banned users database' });
                await logAction('BAN', interaction.user, member.user, 'Matched banned users database');
                bannedCount++;
                
                if (index % 5 === 0 || index === matchedMembers.size - 1) {
                    await progressMessage.edit(`🔨 Banning users (${index + 1}/${matchedMembers.size})...`);
                }
            } catch (banError) {
                console.error(`Failed to ban ${member.user.tag}:`, banError);
                failedBans++;
            }
            
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        const resultEmbed = new EmbedBuilder()
            .setTitle('Banning Complete')
            .setColor(0x00FF00)
            .addFields(
                { name: '✅ Successfully Banned', value: bannedCount.toString(), inline: true },
                { name: '❌ Failed to Ban', value: failedBans.toString(), inline: true }
            )
            .setFooter({ text: `Completed at ${new Date().toLocaleString()}` });

        await interaction.editReply({ content: '', embeds: [resultEmbed] });
    } catch (error) {
        console.error('Ban error:', error);
        await interaction.editReply('❌ An error occurred while banning users.');
    }
}

async function handleSpecificCommand(interaction, hasAdminAccess = false) {
    if (!hasAdminAccess && !interaction.memberPermissions.has(PermissionFlagsBits.BanMembers)) {
        return interaction.reply({
            content: 'You need ban permissions to use this command.',
            ephemeral: true
        });
    }

    const userId = interaction.options.getString('userid');
    if (!/^\d+$/.test(userId)) {
        return interaction.reply({
            content: 'Invalid user ID format.',
            ephemeral: true
        });
    }

    await interaction.deferReply();
    
    try {
        const member = await interaction.guild.members.fetch(userId).catch(() => null);
        const userData = bannedUsers.get(userId);
        const isBanned = bannedUsers.has(userId);
        
        const embed = new EmbedBuilder()
            .setTitle('User Check')
            .setColor(isBanned ? 0xFF0000 : 0x00FF00)
            .addFields(
                { name: 'In Server', value: member ? '✅ Yes' : '❌ No', inline: true },
                { name: 'In Database', value: isBanned ? '✅ Yes' : '❌ No', inline: true }
            );
        
        if (isBanned) {
            embed.addFields(
                { name: 'Username', value: userData?.username || 'unknown', inline: true },
                { name: 'Server', value: userData?.server || 'unknown', inline: true }
            );
        }
        
        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error('Specific check error:', error);
        await interaction.editReply('❌ Error checking user.');
    }
}

async function handlePingCommand(interaction) {
    const sent = await interaction.reply({ content: 'Pinging...', fetchReply: true });
    const latency = sent.createdTimestamp - interaction.createdTimestamp;
    
    const embed = new EmbedBuilder()
        .setTitle('🏓 Pong!')
        .setColor(0x00FF00)
        .addFields(
            { name: 'Bot Latency', value: `${latency}ms`, inline: true },
            { name: 'API Latency', value: `${Math.round(client.ws.ping)}ms`, inline: true }
        );
    
    await interaction.editReply({ content: '', embeds: [embed] });
}

async function handleHelpCommand(interaction) {
    const embed = new EmbedBuilder()
        .setTitle('RoCleaner Help')
        .setColor(0x0099FF)
        .addFields(
            { name: '/scan', value: 'Find banned users in this server' },
            { name: '/banusers', value: 'Ban all detected banned users' },
            { name: '/specific <userID>', value: 'Check a specific user' },
            { name: '/addban <id> <name> <server>', value: 'Add to banned database' },
            { name: '/removeban <id>', value: 'Remove from banned database' },
            { name: '/database', value: 'Show database status' },
            { name: '/dms', value: 'Send warning DM to user' },
            { name: '/pingflagged', value: 'Ping all flagged users' }
        );
    
    await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleReloadCommand(interaction, hasAdminAccess = false) {
    if (!hasAdminAccess && !interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({
            content: 'You need administrator permissions.',
            ephemeral: true
        });
    }

    await interaction.deferReply({ ephemeral: true });
    const success = await loadBannedUsers();
    await interaction.editReply(
        success ? '✅ Database reloaded.' : '❌ Failed to reload database.'
    );
}

async function handleAddBanCommand(interaction, hasAdminAccess = false) {
    if (!hasAdminAccess && !interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({
            content: 'You need administrator permissions.',
            ephemeral: true
        });
    }

    const userId = interaction.options.getString('userid');
    const username = interaction.options.getString('username');
    const server = interaction.options.getString('server');

    if (!/^\d+$/.test(userId)) {
        return interaction.reply({
            content: 'Invalid user ID format.',
            ephemeral: true
        });
    }

    if (bannedUsers.has(userId)) {
        return interaction.reply({
            content: 'This user is already in the database.',
            ephemeral: true
        });
    }

    try {
        bannedUsers.set(userId, { username, server });
        await fs.appendFile(databasePath, `\n${userId} ${username} ${server}`);
        
        await interaction.reply({
            content: `✅ Added ${userId} (${username} from ${server}) to database.`,
            ephemeral: true
        });
    } catch (error) {
        console.error('Add ban error:', error);
        await interaction.reply({
            content: '❌ Failed to add user.',
            ephemeral: true
        });
    }
}

async function handleRemoveBanCommand(interaction, hasAdminAccess = false) {
    if (!hasAdminAccess && !interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({
            content: 'You need administrator permissions.',
            ephemeral: true
        });
    }

    const userId = interaction.options.getString('userid');
    
    if (!bannedUsers.has(userId)) {
        return interaction.reply({
            content: 'This user is not in the database.',
            ephemeral: true
        });
    }

    try {
        bannedUsers.delete(userId);
        const newData = Array.from(bannedUsers)
            .map(([id, data]) => `${id} ${data.username} ${data.server}`)
            .join('\n');
        
        await fs.writeFile(databasePath, newData);
        
        await interaction.reply({
            content: `✅ Removed ${userId} from database.`,
            ephemeral: true
        });
    } catch (error) {
        console.error('Remove ban error:', error);
        await interaction.reply({
            content: '❌ Failed to remove user.',
            ephemeral: true
        });
    }
}

async function handleDatabaseCommand(interaction, hasAdminAccess = false) {
    if (!hasAdminAccess && !interaction.memberPermissions.has(PermissionFlagsBits.BanMembers)) {
        return interaction.reply({
            content: 'You need ban permissions.',
            ephemeral: true
        });
    }

    try {
        let lastUpdated = 'Unknown';
        try {
            const stats = await fs.stat(databasePath);
            lastUpdated = stats.mtime.toLocaleString();
        } catch (e) {
            console.error('File stat error:', e);
        }

        const embed = new EmbedBuilder()
            .setTitle('Database Status')
            .setColor(0x3498db)
            .addFields(
                { name: 'Total Banned Users', value: bannedUsers.size.toString(), inline: true },
                { name: 'Last Updated', value: lastUpdated, inline: true }
            );

        await interaction.reply({ embeds: [embed], ephemeral: true });
    } catch (error) {
        console.error('Database command error:', error);
        await interaction.reply({
            content: '❌ Error fetching database info.',
            ephemeral: true
        });
    }
}

async function handleDMsCommand(interaction, hasAdminAccess = false) {
    if (!hasAdminAccess && !interaction.memberPermissions.has(PermissionFlagsBits.BanMembers)) {
        return interaction.reply({
            content: 'You need ban permissions to use this command.',
            ephemeral: true
        });
    }

    const targetUser = interaction.options.getUser('user');
    const customMessage = interaction.options.getString('message') || 
        '⚠️ Warning: Your account has been detected in our banned users database.';

    try {
        const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
        if (!member) {
            return interaction.reply({
                content: '❌ That user is not in this server.',
                ephemeral: true
            });
        }

        const isBanned = bannedUsers.has(targetUser.id);
        
        try {
            const dmMessage = `${customMessage}\n\n` +
                `🔍 Match Status: ${isBanned ? 'BANNED' : 'NOT BANNED'}\n` +
                `🛡️ Server: ${interaction.guild.name}\n` +
                `👤 Moderator: ${interaction.user.tag}`;

            await targetUser.send(dmMessage);
            
            await logAction('WARNING_DM', interaction.user, targetUser, customMessage);

            await interaction.reply({
                content: `✅ Successfully sent warning DM to ${targetUser.tag}`,
                ephemeral: true
            });
        } catch (dmError) {
            console.error('Failed to send DM:', dmError);
            await interaction.reply({
                content: '❌ Could not send DM to this user (they may have DMs disabled).',
                ephemeral: true
            });
        }

    } catch (error) {
        console.error('DMs command error:', error);
        await interaction.reply({
            content: '❌ An error occurred while processing this command.',
            ephemeral: true
        });
    }
}

async function handlePingFlaggedCommand(interaction, hasAdminAccess = false) {
    if (!hasAdminAccess && !interaction.memberPermissions.has(PermissionFlagsBits.BanMembers)) {
        return interaction.reply({
            content: 'You need ban permissions to use this command.',
            ephemeral: true
        });
    }

    await interaction.deferReply();
    
    try {
        await loadBannedUsers();
        const members = await interaction.guild.members.fetch();
        const matchedMembers = members.filter(member => 
            !member.user.bot && bannedUsers.has(member.user.id)
        );

        if (matchedMembers.size === 0) {
            return interaction.editReply('✅ No flagged users found in this server.');
        }


        const userChunks = [];
        const matchedArray = Array.from(matchedMembers.values());
        
        for (let i = 0; i < matchedArray.length; i += 25) {
            userChunks.push(matchedArray.slice(i, i + 25));
        }

        const embeds = [];
        const mentions = matchedMembers.map(member => member.toString()).join(' ');
        
      
        const firstEmbed = new EmbedBuilder()
            .setTitle('🚨 Flagged Users Detected')
            .setColor(0xFFA500)
            .setDescription(`Found ${matchedMembers.size} flagged users in this server`);

        userChunks[0].forEach(member => {
            const userData = bannedUsers.get(member.user.id);
            firstEmbed.addFields({
                name: `${member.user.tag} (${userData?.username || 'unknown'})`,
                value: `ID: ${member.user.id}\nServer: ${userData?.server || 'unknown'}`,
                inline: true
            });
        });

        embeds.push(firstEmbed);

        for (let i = 1; i < userChunks.length; i++) {
            const additionalEmbed = new EmbedBuilder()
                .setTitle(`🚨 Flagged Users Detected (Continued)`)
                .setColor(0xFFA500);
                
            userChunks[i].forEach(member => {
                const userData = bannedUsers.get(member.user.id);
                additionalEmbed.addFields({
                    name: `${member.user.tag} (${userData?.username || 'unknown'})`,
                    value: `ID: ${member.user.id}\nServer: ${userData?.server || 'unknown'}`,
                    inline: true
                });
            });
            
            embeds.push(additionalEmbed);
        }

        embeds[embeds.length - 1].setFooter({ 
            text: `Action performed by ${interaction.user.tag}` 
        });

        await interaction.editReply({ 
            content: mentions,
            embeds: embeds
        });
    } catch (error) {
        console.error('Ping flagged error:', error);
        await interaction.editReply('❌ An error occurred while processing flagged users.');
    }
}

process.on('unhandledRejection', error => {
    console.error('Unhandled rejection:', error);
});


client.login(config.token);