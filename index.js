
const { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const fs = require('fs').promises;
const path = require('path');

const TOKEN = 'BOT_TOKEN';

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildPresences
    ]
});

// Store counter configurations
const counterConfigs = new Map();
const CONFIG_FILE = path.join(__dirname, 'config.json');

// Logging functions
async function logMessage(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const logEntry = {
        timestamp,
        level,
        message,
        data
    };
    
    console.log(`[${timestamp}] ${level.toUpperCase()}: ${message}`, data ? data : '');
    
    // Write to log file
    try {
        const logLine = JSON.stringify(logEntry) + '\n';
        await fs.appendFile('bot.log', logLine);
    } catch (error) {
        console.error('Failed to write to log file:', error);
    }
}

// Save configurations to file
async function saveConfigs() {
    try {
        const configData = {
            counterConfigs: {}
        };
        
        // Add server names to the configuration data
        for (const [guildId, configs] of counterConfigs.entries()) {
            const guild = client.guilds.cache.get(guildId);
            configData.counterConfigs[guildId] = {
                serverName: guild ? guild.name : 'Unknown Server',
                configs: configs
            };
        }
        
        await fs.writeFile(CONFIG_FILE, JSON.stringify(configData, null, 2));
        await logMessage('info', 'Configurations saved successfully');
    } catch (error) {
        await logMessage('error', 'Failed to save configurations', { error: error.message });
    }
}

// Load configurations from file
async function loadConfigs() {
    try {
        const data = await fs.readFile(CONFIG_FILE, 'utf8');
        const configData = JSON.parse(data);
        
        if (configData.counterConfigs) {
            counterConfigs.clear();
            for (const [guildId, guildData] of Object.entries(configData.counterConfigs)) {
                // Handle both old format (direct configs array) and new format (object with serverName and configs)
                if (Array.isArray(guildData)) {
                    // Old format - just configs array
                    counterConfigs.set(guildId, guildData);
                } else if (guildData.configs) {
                    // New format - object with serverName and configs
                    counterConfigs.set(guildId, guildData.configs);
                }
            }
        }
        
        await logMessage('info', 'Configurations loaded successfully', { 
            guilds: counterConfigs.size 
        });
    } catch (error) {
        await logMessage('warn', 'No existing configuration file found or failed to load', { 
            error: error.message 
        });
    }
}

// Counter types available
const COUNTER_TYPES = {
    'members': 'Total Members',
    'bots': 'Total Bots',
    'roles': 'Members with Roles',
    'online-members': 'Online Members',
    'online-bots': 'Online Bots',
    'offline-members': 'Offline Members',
    'offline-bots': 'Offline Bots'
};

// Define slash commands
const commands = [
    new SlashCommandBuilder()
        .setName('counter-setup')
        .setDescription('Set up a counter channel')
        .addStringOption(option =>
            option.setName('type')
                .setDescription('Type of counter')
                .setRequired(true)
                .addChoices(
                    { name: 'Total Members', value: 'members' },
                    { name: 'Total Bots', value: 'bots' },
                    { name: 'Members with Roles', value: 'roles' },
                    { name: 'Online Members', value: 'online-members' },
                    { name: 'Online Bots', value: 'online-bots' },
                    { name: 'Offline Members', value: 'offline-members' },
                    { name: 'Offline Bots', value: 'offline-bots' }
                ))
        .addStringOption(option =>
            option.setName('category')
                .setDescription('Category name for the counter channel')
                .setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
    
    new SlashCommandBuilder()
        .setName('counter-list')
        .setDescription('List all available counter types'),
    
    new SlashCommandBuilder()
        .setName('counter-reset')
        .setDescription('Reset all counter configurations for this server')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
];

// Register slash commands
async function registerCommands() {
    try {
        console.log('Started refreshing application (/) commands.');
        
        const rest = new REST({ version: '10' }).setToken(TOKEN);
        
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands.map(command => command.toJSON()) }
        );
        
        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error('Error registering commands:', error);
    }
}

client.once('ready', async () => {
    console.log(`Bot is ready! Logged in as ${client.user.tag}`);
    await logMessage('info', `Bot started successfully`, { tag: client.user.tag });
    
    // Load existing configurations
    await loadConfigs();
    
    // Register slash commands
    await registerCommands();
    
    // Update counters every 5 minutes
    setInterval(updateAllCounters, 5 * 60 * 1000);
    
    // Save configurations every 10 minutes
    setInterval(saveConfigs, 10 * 60 * 1000);
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    
    const { commandName } = interaction;
    
    if (commandName === 'counter-setup') {
        await handleCounterSetup(interaction);
    } else if (commandName === 'counter-list') {
        await listCounterTypes(interaction);
    } else if (commandName === 'counter-reset') {
        await handleCounterReset(interaction);
    }
});

async function handleCounterSetup(interaction) {
    const counterType = interaction.options.getString('type');
    const categoryName = interaction.options.getString('category');
    
    try {
        // Check permissions
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
            return interaction.reply({ 
                content: 'You need "Manage Channels" permission to set up counters.',
                ephemeral: true
            });
        }
        
        await interaction.deferReply();
        
        // Create or find category
        let category = interaction.guild.channels.cache.find(
            c => c.type === ChannelType.GuildCategory && c.name === categoryName
        );
        
        if (!category) {
            category = await interaction.guild.channels.create({
                name: categoryName,
                type: ChannelType.GuildCategory,
                permissionOverwrites: [
                    {
                        id: interaction.guild.roles.everyone,
                        deny: [PermissionFlagsBits.Connect],
                    },
                ],
            });
        }
        
        // Get current count
        const count = await getCountForType(interaction.guild, counterType);
        
        // Create counter channel
        const channelName = `${COUNTER_TYPES[counterType]}: ${count}`;
        const counterChannel = await interaction.guild.channels.create({
            name: channelName,
            type: ChannelType.GuildVoice,
            parent: category.id,
            permissionOverwrites: [
                {
                    id: interaction.guild.roles.everyone,
                    deny: [PermissionFlagsBits.Connect],
                },
            ],
        });
        
        // Store configuration
        const guildId = interaction.guild.id;
        if (!counterConfigs.has(guildId)) {
            counterConfigs.set(guildId, []);
        }
        
        counterConfigs.get(guildId).push({
            channelId: counterChannel.id,
            type: counterType,
            categoryId: category.id
        });
        
        // Save configurations immediately after setup
        await saveConfigs();
        await logMessage('info', 'Counter setup completed', {
            guild: interaction.guild.name,
            guildId: guildId,
            type: counterType,
            channelId: counterChannel.id,
            categoryId: category.id
        });
        
        const embed = {
            title: '✅ Counter Setup Complete',
            description: 'Your counter channel has been created successfully!',
            color: 0x00ff00,
            fields: [
                {
                    name: '📊 Counter Type',
                    value: COUNTER_TYPES[counterType],
                    inline: true
                },
                {
                    name: '📁 Category',
                    value: categoryName,
                    inline: true
                },
                {
                    name: '🔊 Channel',
                    value: counterChannel.name,
                    inline: false
                },
                {
                    name: '📈 Current Count',
                    value: count.toString(),
                    inline: true
                }
            ],
            footer: {
                text: 'Counter will auto-update every 5 minutes'
            },
            timestamp: new Date().toISOString()
        };

        await interaction.editReply({ embeds: [embed] });
        
    } catch (error) {
        await logMessage('error', 'Counter setup failed', {
            guild: interaction.guild?.name,
            guildId: interaction.guild?.id,
            error: error.message,
            stack: error.stack
        });
        
        const errorEmbed = {
            title: '❌ Counter Setup Failed',
            description: 'An error occurred while creating the counter channel.',
            color: 0xff0000,
            fields: [
                {
                    name: 'Possible Solutions',
                    value: '• Check bot permissions\n• Ensure "Manage Channels" permission\n• Verify bot role hierarchy',
                    inline: false
                }
            ],
            footer: {
                text: 'Contact an administrator if the issue persists'
            }
        };

        await interaction.editReply({ embeds: [errorEmbed] });
    }
}

async function listCounterTypes(interaction) {
    const typesList = Object.entries(COUNTER_TYPES)
        .map(([key, value]) => `• \`${key}\` - ${value}`)
        .join('\n');
    
    const embed = {
        title: '📊 Available Counter Types',
        description: typesList,
        color: 0x0099ff,
        footer: {
            text: 'Use /counter-setup to create a counter'
        }
    };
    
    await interaction.reply({ embeds: [embed] });
}

async function handleCounterReset(interaction) {
    try {
        // Check permissions
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ 
                content: 'You need "Administrator" permission to reset counters.',
                ephemeral: true
            });
        }
        
        await interaction.deferReply();
        
        const guildId = interaction.guild.id;
        const configs = counterConfigs.get(guildId);
        
        if (!configs || configs.length === 0) {
            const noCountersEmbed = {
                title: '❌ No Counters Found',
                description: 'This server has no counter configurations to reset.',
                color: 0xff9900,
                footer: {
                    text: 'Use /counter-setup to create counters'
                }
            };
            
            return await interaction.editReply({ embeds: [noCountersEmbed] });
        }
        
        let deletedChannels = 0;
        let failedDeletions = 0;
        
        // Delete all counter channels and categories
        for (const config of configs) {
            try {
                const channel = interaction.guild.channels.cache.get(config.channelId);
                if (channel) {
                    await channel.delete();
                    deletedChannels++;
                }
                
                // Try to delete category if it's empty
                const category = interaction.guild.channels.cache.get(config.categoryId);
                if (category && category.children.cache.size === 0) {
                    await category.delete();
                }
                
            } catch (error) {
                failedDeletions++;
                await logMessage('error', 'Failed to delete counter channel', {
                    guild: interaction.guild.name,
                    channelId: config.channelId,
                    error: error.message
                });
            }
        }
        
        // Clear configurations for this guild
        counterConfigs.delete(guildId);
        await saveConfigs();
        
        await logMessage('info', 'Counter reset completed', {
            guild: interaction.guild.name,
            guildId: guildId,
            deletedChannels: deletedChannels,
            failedDeletions: failedDeletions
        });
        
        const successEmbed = {
            title: '🔄 Counter Reset Complete',
            description: 'All counter configurations have been reset for this server.',
            color: 0x00ff00,
            fields: [
                {
                    name: '🗑️ Channels Deleted',
                    value: deletedChannels.toString(),
                    inline: true
                },
                {
                    name: '⚠️ Failed Deletions',
                    value: failedDeletions.toString(),
                    inline: true
                },
                {
                    name: '📋 Next Steps',
                    value: 'Use `/counter-setup` to create new counter channels',
                    inline: false
                }
            ],
            footer: {
                text: 'All configurations have been cleared'
            },
            timestamp: new Date().toISOString()
        };
        
        await interaction.editReply({ embeds: [successEmbed] });
        
    } catch (error) {
        await logMessage('error', 'Counter reset failed', {
            guild: interaction.guild?.name,
            guildId: interaction.guild?.id,
            error: error.message,
            stack: error.stack
        });
        
        const errorEmbed = {
            title: '❌ Counter Reset Failed',
            description: 'An error occurred while resetting counter configurations.',
            color: 0xff0000,
            fields: [
                {
                    name: 'Possible Solutions',
                    value: '• Check bot permissions\n• Ensure "Manage Channels" permission\n• Try again in a few moments',
                    inline: false
                }
            ],
            footer: {
                text: 'Contact an administrator if the issue persists'
            }
        };

        await interaction.editReply({ embeds: [errorEmbed] });
    }
}

async function getCountForType(guild, type) {
    const members = await guild.members.fetch();
    
    switch (type) {
        case 'members':
            return members.filter(m => !m.user.bot).size;
        
        case 'bots':
            return members.filter(m => m.user.bot).size;
        
        case 'roles':
            return members.filter(m => !m.user.bot && m.roles.cache.size > 1).size;
        
        case 'online-members':
            return members.filter(m => !m.user.bot && ['online', 'idle', 'dnd'].includes(m.presence?.status)).size;
        
        case 'online-bots':
            return members.filter(m => m.user.bot && ['online', 'idle', 'dnd'].includes(m.presence?.status)).size;
        
        case 'offline-members':
            return members.filter(m => !m.user.bot && (!m.presence || m.presence.status === 'offline')).size;
        
        case 'offline-bots':
            return members.filter(m => m.user.bot && (!m.presence || m.presence.status === 'offline')).size;
        
        default:
            return 0;
    }
}

async function updateAllCounters() {
    for (const [guildId, configs] of counterConfigs.entries()) {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) continue;
        
        for (const config of configs) {
            try {
                const channel = guild.channels.cache.get(config.channelId);
                if (!channel) continue;
                
                const count = await getCountForType(guild, config.type);
                const newName = `${COUNTER_TYPES[config.type]}: ${count}`;
                
                if (channel.name !== newName) {
                    await channel.setName(newName);
                    await logMessage('debug', 'Counter updated', {
                        guild: guild.name,
                        channel: newName,
                        type: config.type
                    });
                }
                
            } catch (error) {
                await logMessage('error', 'Counter update failed', {
                    guild: guild.name,
                    channelId: config.channelId,
                    type: config.type,
                    error: error.message
                });
            }
        }
    }
}

// Update counters when members join/leave
client.on('guildMemberAdd', async (member) => {
    setTimeout(() => updateGuildCounters(member.guild), 1000);
});

client.on('guildMemberRemove', async (member) => {
    setTimeout(() => updateGuildCounters(member.guild), 1000);
});

// Update counters when presence changes
client.on('presenceUpdate', async (oldPresence, newPresence) => {
    if (newPresence?.guild) {
        setTimeout(() => updateGuildCounters(newPresence.guild), 1000);
    }
});

// Send welcome message when bot joins a server
client.on('guildCreate', async (guild) => {
    try {
        await logMessage('info', 'Bot joined new server', {
            guild: guild.name,
            guildId: guild.id,
            memberCount: guild.memberCount
        });

        // Find a suitable channel to send welcome message
        const channel = guild.channels.cache.find(channel => 
            channel.type === ChannelType.GuildText && 
            channel.permissionsFor(guild.members.me)?.has([
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ViewChannel
            ])
        );

        if (channel) {
            const welcomeEmbed = {
                title: '🎉 Thank you for inviting me!',
                description: 'I\'m your new counter bot! I can help you track various server statistics.',
                color: 0x00ff00,
                fields: [
                    {
                        name: '📊 Available Commands',
                        value: '• `/counter-setup` - Set up a counter channel\n• `/counter-list` - View all counter types',
                        inline: false
                    },
                    {
                        name: '🔧 Counter Types Available',
                        value: '• Total Members\n• Total Bots\n• Online/Offline Members\n• Online/Offline Bots\n• Members with Roles',
                        inline: false
                    },
                    {
                        name: '⚙️ Required Permissions',
                        value: 'Make sure I have "Manage Channels" permission to create counter channels!',
                        inline: false
                    }
                ],
                footer: {
                    text: 'Use /counter-setup to get started!'
                },
                timestamp: new Date().toISOString()
            };

            await channel.send({ embeds: [welcomeEmbed] });
            
            await logMessage('info', 'Welcome message sent', {
                guild: guild.name,
                channel: channel.name
            });
        } else {
            await logMessage('warn', 'No suitable channel found to send welcome message', {
                guild: guild.name,
                guildId: guild.id
            });
        }

    } catch (error) {
        await logMessage('error', 'Failed to send welcome message', {
            guild: guild.name,
            guildId: guild.id,
            error: error.message
        });
    }
});

async function updateGuildCounters(guild) {
    const configs = counterConfigs.get(guild.id);
    if (!configs) return;
    
    for (const config of configs) {
        try {
            const channel = guild.channels.cache.get(config.channelId);
            if (!channel) continue;
            
            const count = await getCountForType(guild, config.type);
            const newName = `${COUNTER_TYPES[config.type]}: ${count}`;
            
            if (channel.name !== newName) {
                await channel.setName(newName);
            }
            
        } catch (error) {
            console.error(`Error updating counter ${config.channelId}:`, error);
        }
    }
}

// Graceful shutdown handling
process.on('SIGINT', async () => {
    await logMessage('info', 'Bot shutting down gracefully');
    await saveConfigs();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    await logMessage('info', 'Bot terminated gracefully');
    await saveConfigs();
    process.exit(0);
});

// Handle unhandled errors
process.on('unhandledRejection', async (reason, promise) => {
    await logMessage('error', 'Unhandled rejection', {
        reason: reason,
        promise: promise
    });
});

process.on('uncaughtException', async (error) => {
    await logMessage('error', 'Uncaught exception', {
        error: error.message,
        stack: error.stack
    });
    await saveConfigs();
    process.exit(1);
});

// Login with bot token
client.login(TOKEN);
