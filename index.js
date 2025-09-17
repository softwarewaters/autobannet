// index.js
require("dotenv").config();
const fs = require("fs");
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  ActivityType,
  PermissionFlagsBits,
  EmbedBuilder,
  AuditLogEvent
} = require("discord.js");
const express = require("express");
const cron = require("node-cron"); // Import the node-cron library
const app = express();

// ---------- Health Check Server for Render & Uptime Robot ----------
app.get("/", (req, res) => res.send("✅ AutoBanNet is running!"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Health check server listening on port ${PORT}`));

const CONFIG_PATH = "./config.json";
let config = {};
if (fs.existsSync(CONFIG_PATH)) {
  try { config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
  catch (err) { console.error("Failed to parse config.json:", err); config = {}; }
}
if (!config._global) config._global = { blacklistedGuilds: [] };

function saveConfig() { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); }

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildBans],
  partials: [Partials.GuildMember]
});

// ---------- Embeds ----------
const makeEmbed = (type, title, desc) => {
  const colors = { success: 0x22c55e, info: 0x06b6d4, error: 0xef4444 };
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(desc)
    .setColor(colors[type] ?? 0x06b6d4)
    .setTimestamp()
    .setFooter({ text: "AutoBanNet" });
};

const logEmbedForAction = ({ action, targetTag, targetId, moderatorTag, reason, guildName, pruneDays }) => {
  const e = new EmbedBuilder()
    .setTitle(`${action} — ${targetTag}`)
    .addFields(
      { name: "Target", value: `${targetTag} (\`${targetId}\`)`, inline: true },
      { name: "Server", value: `${guildName}`, inline: true },
      { name: "Moderator", value: moderatorTag ?? "Unknown", inline: true }
    )
    .setFooter({ text: "AutoBanNet" })
    .setTimestamp();
  if (reason) e.addFields({ name: "Reason", value: reason, inline: false });
  if (typeof pruneDays !== "undefined") e.addFields({ name: "Prune Days", value: String(pruneDays), inline: true });
  if (action.toLowerCase().includes("ban")) e.setColor(0x22c55e);
  else e.setColor(0x06b6d4);
  return e;
};

// ---------- Commands ----------
const setupCommand = new SlashCommandBuilder()
  .setName("setup")
  .setDescription("Configure AutoBanNet for this server")
  .addSubcommand(sc => sc.setName("moderationrole")
    .setDescription("Set a role allowed to use moderation commands")
    .addRoleOption(o => o.setName("role").setDescription("Role").setRequired(true)))
  .addSubcommand(sc => sc.setName("bansync")
    .setDescription("Add/Remove servers to sync bans with")
    .addStringOption(o => o.setName("action").setDescription("add/remove").setRequired(true)
      .addChoices({ name: "add", value: "add" }, { name: "remove", value: "remove" }))
    .addStringOption(o => o.setName("guildid").setDescription("Guild ID").setRequired(true)))
  .addSubcommand(sc => sc.setName("view").setDescription("View current setup"))
  .addSubcommand(sc => sc.setName("logchannel")
    .setDescription("Set or clear the server's mod-log channel (omit to clear)")
    .addChannelOption(o => o.setName("channel").setDescription("Channel").setRequired(false)))
  .addSubcommand(sc => sc.setName("blacklist")
    .setDescription("Manage global blacklist servers")
    .addStringOption(o => o.setName("action").setDescription("add/remove/list").setRequired(true)
      .addChoices({ name: "add", value: "add" }, { name: "remove", value: "remove" }, { name: "list", value: "list" }))
    .addStringOption(o => o.setName("guildid").setDescription("Guild ID").setRequired(false)))
  .addSubcommand(sc => sc.setName("automessage")
    .setDescription("Set or clear an automatic message to be sent every 6 hours")
    .addStringOption(o => o.setName("action").setDescription("Set or Clear the message").setRequired(true)
      .addChoices({ name: "set", value: "set" }, { name: "clear", value: "clear" }))
    .addChannelOption(o => o.setName("channel").setDescription("Channel for the message").setRequired(false))
    .addStringOption(o => o.setName("message").setDescription("The message content (required for 'set')").setRequired(false)));


const banCommand = new SlashCommandBuilder()
  .setName("ban")
  .setDescription("Ban a user (restricted to moderation roles)")
  .addUserOption(o => o.setName("user").setDescription("User to ban").setRequired(true))
  .addStringOption(o => o.setName("reason").setDescription("Reason for ban"))
  .addIntegerOption(o => o.setName("delete_days").setDescription("Prune message days (0-7)"));

const kickCommand = new SlashCommandBuilder()
  .setName("kick")
  .setDescription("Kick a user (restricted to moderation roles)")
  .addUserOption(o => o.setName("user").setDescription("User to kick").setRequired(true))
  .addStringOption(o => o.setName("reason").setDescription("Reason for kick"));

const unbanCommand = new SlashCommandBuilder()
  .setName("unban")
  .setDescription("Unban a user by ID (restricted to moderation roles)")
  .addStringOption(o => o.setName("userid").setDescription("User ID to unban").setRequired(true))
  .addStringOption(o => o.setName("reason").setDescription("Reason for unban"));

const commandList = [setupCommand.toJSON(), banCommand.toJSON(), kickCommand.toJSON(), unbanCommand.toJSON()];

// ---------- REST & Registration ----------
const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);

async function registerCommands() {
  if (!process.env.CLIENT_ID || !process.env.TOKEN) {
    console.error("Missing CLIENT_ID or TOKEN in .env");
    return;
  }
  try {
    if (process.env.TEST_GUILD_ID) {
      console.log("Registering commands to test guild:", process.env.TEST_GUILD_ID);
      const data = await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.TEST_GUILD_ID),
        { body: commandList });
      console.log(`✅ Registered ${data.length} guild commands for ${process.env.TEST_GUILD_ID}`);
      try {
        const globalCommands = await rest.get(Routes.applicationCommands(process.env.CLIENT_ID));
        for (const gCmd of globalCommands) {
          if (commandList.some(c => c.name === gCmd.name)) {
            await rest.delete(Routes.applicationCommand(process.env.CLIENT_ID, gCmd.id));
            console.log(`→ Removed duplicate global command '${gCmd.name}'`);
          }
        }
      } catch (err) { console.warn("Could not clean global commands:", err.message || err); }
    } else {
      console.log("Registering global application commands (may take up to an hour to appear)...");
      const data = await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commandList });
      console.log(`✅ Registered ${data.length} global application commands`);
    }
  } catch (err) {
    console.error("Failed to register commands:", err);
  }
}
registerCommands();

// ---------- Presence and Auto-Messages ----------
client.once("ready", () => {
  console.log(`${client.user.tag} is online!`);
  client.user.setPresence({
    activities: [{ name: "Protecting servers • AutoBanNet 🔒", type: ActivityType.Watching }],
    status: "online"
  });

  // Schedule automatic messages for all configured guilds
  for (const guildId in config) {
    if (config[guildId] && config[guildId].autoMessage) {
      const { channelId, messageContent } = config[guildId].autoMessage;
      if (channelId && messageContent) {
        cron.schedule("0 */6 * * *", async () => { // Every 6 hours
          try {
            const channel = await client.channels.fetch(channelId).catch(() => null);
            if (channel && channel.isTextBased()) {
              await channel.send(messageContent);
              console.log(`Sent auto-message to channel ${channelId} in guild ${guildId}`);
            }
          } catch (err) {
            console.error(`Failed to send auto-message to channel ${channelId}:`, err);
          }
        });
      }
    }
  }
});

// ---------- Helpers ----------
function hasModPermission(member) {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator) || member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  const guildCfg = config[member.guild.id];
  if (!guildCfg || !Array.isArray(guildCfg.roles)) return false;
  return member.roles.cache.some(r => guildCfg.roles.includes(r.id));
}

async function sendLogToGuild(guildId, embed) {
  try {
    if (!config[guildId] || !config[guildId].logChannelId) return;
    const chId = config[guildId].logChannelId;
    const ch = await client.channels.fetch(chId).catch(() => null);
    if (!ch || !ch.send) { console.warn(`No accessible channel ${chId} in guild ${guildId}`); return; }
    await ch.send({ embeds: [embed] });
  } catch (err) { console.warn("Failed to send log embed:", err.message || err); }
}

async function banUserAcrossAllGuilds(userId, reason, originGuildName = "AutoBanNet", moderatorTag = "AutoBanNet (blacklist)") {
  for (const [gId, guild] of client.guilds.cache) {
    try {
      const me = guild.members.me;
      if (!me) continue;
      if (!me.permissions.has(PermissionFlagsBits.BanMembers)) continue;
      await guild.bans.create(userId, { reason: `[AutoBanNet] ${reason}` }).catch(() => null);
      const embed = logEmbedForAction({
        action: "Auto-Ban (Blacklist)",
        targetTag: `${userId}`,
        targetId: userId,
        moderatorTag: moderatorTag,
        reason: reason,
        guildName: `${guild.name} (auto)`,
      });
      await sendLogToGuild(gId, embed);
    } catch (err) {
      console.warn(`Failed to auto-ban ${userId} in guild ${gId}:`, err.message || err);
    }
  }
}

// ---------- Interaction Handler ----------
client.on("interactionCreate", async interaction => {
  try {
    if (!interaction.isChatInputCommand()) return;
    const cmd = interaction.commandName;

    // ---------- Setup ----------
    if (cmd === "setup") {
      if (!interaction.guild) return interaction.reply({ embeds: [makeEmbed("error", "Server Only", "This command must be used inside a server.")], ephemeral: false });
      const sub = interaction.options.getSubcommand();
      if (!config[interaction.guild.id]) config[interaction.guild.id] = { roles: [], banSyncGuilds: [], logChannelId: null, autoMessage: null };
      const invoker = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
      if (!invoker || !invoker.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ embeds: [makeEmbed("error", "No Permission", "You need Manage Server permission to run setup.")], ephemeral: false });
      }

      if (sub === "moderationrole") {
        const role = interaction.options.getRole("role");
        if (!config[interaction.guild.id].roles.includes(role.id)) {
          config[interaction.guild.id].roles.push(role.id);
          saveConfig();
          return interaction.reply({ embeds: [makeEmbed("success", "Moderation Role Added", `✅ **${role.name}** is now a moderation role.`)], ephemeral: false });
        }
        return interaction.reply({ embeds: [makeEmbed("info", "Already Configured", `⚠️ **${role.name}** is already a moderation role.`)], ephemeral: false });
      }

      if (sub === "bansync") {
        const action = interaction.options.getString("action");
        const gid = interaction.options.getString("guildid");
        if (action === "add") {
          if (!config[interaction.guild.id].banSyncGuilds.includes(gid)) {
            config[interaction.guild.id].banSyncGuilds.push(gid);
            saveConfig();
            const embed = makeEmbed("success", "Ban Sync Added", `✅ Guild ID **${gid}** added to ban sync list.`);
            await interaction.reply({ embeds: [embed], ephemeral: false });
            await sendLogToGuild(interaction.guild.id, new EmbedBuilder().setTitle("Ban-Sync: Server Added").setDescription(`Guild ID \`${gid}\` was added to ban-sync list by <@${interaction.user.id}>`).setTimestamp());
            return;
          } else {
            return interaction.reply({ embeds: [makeEmbed("info", "Already Added", `⚠️ Guild ID **${gid}** is already in the ban sync list.`)], ephemeral: false });
          }
        } else {
          config[interaction.guild.id].banSyncGuilds = config[interaction.guild.id].banSyncGuilds.filter(x => x !== gid);
          saveConfig();
          const embed = makeEmbed("success", "Ban Sync Removed", `✅ Guild ID **${gid}** removed from ban sync list.`);
          await interaction.reply({ embeds: [embed], ephemeral: false });
          await sendLogToGuild(interaction.guild.id, new EmbedBuilder().setTitle("Ban-Sync: Server Removed").setDescription(`Guild ID \`${gid}\` removed from ban-sync list by <@${interaction.user.id}>`).setTimestamp());
          return;
        }
      }

      if (sub === "logchannel") {
        const channel = interaction.options.getChannel("channel");
        if (!channel) {
          config[interaction.guild.id].logChannelId = null;
          saveConfig();
          return interaction.reply({ embeds: [makeEmbed("success", "Log Channel Cleared", "✅ Log channel has been cleared.")], ephemeral: false });
        } else {
          if (!channel.isTextBased()) {
            return interaction.reply({ embeds: [makeEmbed("error", "Invalid Channel", "Please provide a text channel.")], ephemeral: false });
          }
          config[interaction.guild.id].logChannelId = channel.id;
          saveConfig();
          return interaction.reply({ embeds: [makeEmbed("success", "Log Channel Set", `✅ Logs will be sent to ${channel} (${channel.id}).`)], ephemeral: false });
        }
      }

      if (sub === "blacklist") {
        const action = interaction.options.getString("action");
        const gid = interaction.options.getString("guildid");
        if (!config._global) config._global = { blacklistedGuilds: [] };

        if (action === "list") {
          const list = config._global.blacklistedGuilds.length ? config._global.blacklistedGuilds.join("\n") : "None";
          return interaction.reply({ embeds: [makeEmbed("info", "Blacklisted Guilds", list)], ephemeral: false });
        }

        if (!gid) return interaction.reply({ embeds: [makeEmbed("error", "Missing Guild ID", "You must provide a guild ID for add/remove.")], ephemeral: false });

        if (action === "add") {
          if (!config._global.blacklistedGuilds.includes(gid)) {
            config._global.blacklistedGuilds.push(gid);
            saveConfig();
            await interaction.reply({ embeds: [makeEmbed("success", "Blacklisted Guild Added", `✅ Guild ID **${gid}** added to global blacklist.`)], ephemeral: false });
            await sendLogToGuild(interaction.guild.id, new EmbedBuilder().setTitle("Blacklist: Server Added").setDescription(`Guild ID \`${gid}\` added to global blacklist by <@${interaction.user.id}>`).setTimestamp());
            return;
          } else {
            return interaction.reply({ embeds: [makeEmbed("info", "Already Blacklisted", `⚠️ Guild ID **${gid}** is already blacklisted.`)], ephemeral: false });
          }
        } else if (action === "remove") {
          config._global.blacklistedGuilds = config._global.blacklistedGuilds.filter(x => x !== gid);
          saveConfig();
          await interaction.reply({ embeds: [makeEmbed("success", "Blacklisted Guild Removed", `✅ Guild ID **${gid}** removed from global blacklist.`)], ephemeral: false });
          await sendLogToGuild(interaction.guild.id, new EmbedBuilder().setTitle("Blacklist: Server Removed").setDescription(`Guild ID \`${gid}\` removed from global blacklist by <@${interaction.user.id}>`).setTimestamp());
          return;
        }
      }
      
      if (sub === "automessage") {
        const action = interaction.options.getString("action");
        const channel = interaction.options.getChannel("channel");
        const messageContent = interaction.options.getString("message");

        if (action === "set") {
          if (!channel || !messageContent) {
            return interaction.reply({ embeds: [makeEmbed("error", "Missing Options", "To set a message, you must provide both a channel and a message.")], ephemeral: true });
          }
          if (!channel.isTextBased()) {
            return interaction.reply({ embeds: [makeEmbed("error", "Invalid Channel", "Please provide a text channel for the auto-message.")], ephemeral: true });
          }
          config[interaction.guild.id].autoMessage = { channelId: channel.id, messageContent: messageContent };
          saveConfig();
          return interaction.reply({ embeds: [makeEmbed("success", "Auto-Message Set", `✅ An automatic message has been set to send every 6 hours in ${channel}.`)], ephemeral: false });
        } else if (action === "clear") {
          config[interaction.guild.id].autoMessage = null;
          saveConfig();
          return interaction.reply({ embeds: [makeEmbed("success", "Auto-Message Cleared", "✅ The automatic message has been cleared.")], ephemeral: false });
        }
      }
    }

    // ---------- Moderation (ban/kick/unban) ----------
    if (cmd === "ban" || cmd === "kick" || cmd === "unban") {
      if (!interaction.guild) return interaction.reply({ embeds: [makeEmbed("error", "Server Only", "This command must be used in a server.")], ephemeral: false });
      const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
      if (!hasModPermission(member)) return interaction.reply({ embeds: [makeEmbed("error", "No Permission", "❌ You do not have permission to use this command.")], ephemeral: false });

      if (cmd === "ban") {
        const targetUser = interaction.options.getUser("user");
        const reason = interaction.options.getString("reason") || `Action by ${interaction.user.tag}`;
        const pruneDays = interaction.options.getInteger("delete_days") ?? 0;
        if (!targetUser) return interaction.reply({ embeds: [makeEmbed("error", "No Target", "Please provide a user to target.")], ephemeral: false });
        if (targetUser.id === interaction.user.id) return interaction.reply({ embeds: [makeEmbed("error", "Invalid Target", "You cannot target yourself.")], ephemeral: false });
        if (!interaction.guild.members.me.permissions.has(PermissionFlagsBits.BanMembers)) return interaction.reply({ embeds: [makeEmbed("error", "Missing Permissions", "I need Ban Members permission.")], ephemeral: false });

        const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
        if (targetMember) {
          const botMember = await interaction.guild.members.fetch(client.user.id).catch(() => null);
          if (botMember && botMember.roles.highest.position <= targetMember.roles.highest.position) {
            return interaction.reply({ embeds: [makeEmbed("error", "Hierarchy Error", "I cannot moderate that user due to role hierarchy.")], ephemeral: false });
          }
        }

        try {
          await interaction.guild.members.ban(targetUser.id, { deleteMessageDays: pruneDays, reason });
          const out = logEmbedForAction({
            action: "User Banned",
            targetTag: `${targetUser.tag}`,
            targetId: targetUser.id,
            moderatorTag: `${interaction.user.tag}`,
            reason,
            guildName: interaction.guild.name,
            pruneDays
          });
          await interaction.reply({ embeds: [out], ephemeral: false });
          await sendLogToGuild(interaction.guild.id, out);

          const gcfg = config[interaction.guild.id];
          if (gcfg && Array.isArray(gcfg.banSyncGuilds) && gcfg.banSyncGuilds.length) {
            for (const tgtG of gcfg.banSyncGuilds) {
              try {
                const tgtGuild = await client.guilds.fetch(tgtG);
                await tgtGuild.bans.create(targetUser.id, { reason: `[AutoBanNet] Synced ban from ${interaction.guild.name}: ${reason}` });
                const syncEmbed = logEmbedForAction({
                  action: "Synced Ban",
                  targetTag: `${targetUser.tag}`,
                  targetId: targetUser.id,
                  moderatorTag: `${interaction.user.tag} (origin)`,
                  reason,
                  guildName: `${tgtGuild.name} (synced from ${interaction.guild.name})`,
                  pruneDays
                });
                await sendLogToGuild(tgtG, syncEmbed);
              } catch (err) { console.warn(`Failed to sync ban to ${tgtG}:`, err.message || err); }
            }
          }
        } catch (err) {
          console.error("Ban failed:", err);
          return interaction.reply({ embeds: [makeEmbed("error", "Ban Failed", `${err.message || err}`)], ephemeral: false });
        }
      }

      if (cmd === "kick") {
        const targetUser = interaction.options.getUser("user");
        const reason = interaction.options.getString("reason") || `Action by ${interaction.user.tag}`;
        if (!targetUser) return interaction.reply({ embeds: [makeEmbed("error", "No Target", "Please provide a user to target.")], ephemeral: false });
        if (!interaction.guild.members.me.permissions.has(PermissionFlagsBits.KickMembers)) return interaction.reply({ embeds: [makeEmbed("error", "Missing Permissions", "I need Kick Members permission.")], ephemeral: false });

        const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
        if (!targetMember) return interaction.reply({ embeds: [makeEmbed("error", "Not In Server", "User is not currently in the server.")], ephemeral: false });

        try {
          await targetMember.kick(reason);
          const out = logEmbedForAction({
            action: "User Kicked",
            targetTag: `${targetUser.tag}`,
            targetId: targetUser.id,
            moderatorTag: `${interaction.user.tag}`,
            reason,
            guildName: interaction.guild.name
          });
          await interaction.reply({ embeds: [out], ephemeral: false });
          await sendLogToGuild(interaction.guild.id, out);
        } catch (err) {
          console.error("Kick failed:", err);
          return interaction.reply({ embeds: [makeEmbed("error", "Kick Failed", `${err.message || err}`)], ephemeral: false });
        }
      }

      if (cmd === "unban") {
        const userId = interaction.options.getString("userid");
        const reason = interaction.options.getString("reason") || `Unban by ${interaction.user.tag}`;
        if (!userId) return interaction.reply({ embeds: [makeEmbed("error", "No ID", "Please provide a user ID.")], ephemeral: false });
        if (!interaction.guild.members.me.permissions.has(PermissionFlagsBits.BanMembers)) return interaction.reply({ embeds: [makeEmbed("error", "Missing Permissions", "I need Ban Members permission.")], ephemeral: false });

        try {
          await interaction.guild.bans.remove(userId, reason);
          const out = logEmbedForAction({
            action: "User Unbanned",
            targetTag: `${userId}`,
            targetId: userId,
            moderatorTag: `${interaction.user.tag}`,
            reason,
            guildName: interaction.guild.name
          });
          await interaction.reply({ embeds: [out], ephemeral: false });
          await sendLogToGuild(interaction.guild.id, out);
        } catch (err) {
          console.error("Unban failed:", err);
          return interaction.reply({ embeds: [makeEmbed("error", "Unban Failed", `${err.message || err}`)], ephemeral: false });
        }
      }
    }
  } catch (err) {
    console.error("Error responding to interaction:", err);
    if (!interaction?.replied) {
      try { await interaction.reply({ embeds: [makeEmbed("error", "Command Error", "An error occurred while executing the command.")], ephemeral: false }); } catch {}
    }
  }
});

// ---------- Guild events ----------
client.on("guildBanAdd", async ban => {
  try {
    const guildId = ban.guild.id;
    let moderatorTag = "Unknown";
    let reason = null;
    try {
      const logs = await ban.guild.fetchAuditLogs({ type: AuditLogEvent.MemberBanAdd, limit: 1 });
      const entry = logs.entries.first();
      if (entry && (Date.now() - entry.createdTimestamp) < 10000) {
        moderatorTag = entry.executor ? `${entry.executor.tag}` : "Unknown";
        reason = entry.reason ?? null;
      }
    } catch (e) { /* ignore audit errors */ }

    const out = logEmbedForAction({
      action: "User Banned (Detected)",
      targetTag: `${ban.user.tag}`,
      targetId: ban.user.id,
      moderatorTag,
      reason,
      guildName: ban.guild.name
    });

    await sendLogToGuild(guildId, out);

    if (config[guildId] && Array.isArray(config[guildId].banSyncGuilds) && config[guildId].banSyncGuilds.length) {
      for (const tgtG of config[guildId].banSyncGuilds) {
        try {
          const tgtGuild = await client.guilds.fetch(tgtG);
          await tgtGuild.bans.create(ban.user.id, { reason: `[AutoBanNet] Synced ban from ${ban.guild.name}: ${reason ?? "No reason"}` });
          const syncEmbed = logEmbedForAction({
            action: "Synced Ban",
            targetTag: `${ban.user.tag}`,
            targetId: ban.user.id,
            moderatorTag: `${moderatorTag} (origin)`,
            reason,
            guildName: `${tgtGuild.name} (synced from ${ban.guild.name})`
          });
          await sendLogToGuild(tgtG, syncEmbed);
        } catch (err) {
          console.warn(`Failed to sync ban to ${tgtG}:`, err.message || err);
        }
      }
    }
  } catch (err) {
    console.error("Error in guildBanAdd handler:", err);
  }
});

client.on("guildMemberAdd", async member => {
  try {
    if (!config._global || !Array.isArray(config._global.blacklistedGuilds) || !config._global.blacklistedGuilds.length) return;

    const userId = member.user.id;
    for (const blackG of config._global.blacklistedGuilds) {
      const blackGuild = client.guilds.cache.get(blackG);
      if (!blackGuild) continue;
      try {
        const found = await blackGuild.members.fetch(userId).catch(() => null);
        if (found) {
          const reason = `Auto-ban: User found in blacklisted guild ${blackGuild.name} (${blackG})`;
          await banUserAcrossAllGuilds(userId, reason, member.guild.name, `AutoBanNet (blacklist: ${blackG})`);
          const out = logEmbedForAction({
            action: "Auto-Ban Triggered",
            targetTag: `${member.user.tag}`,
            targetId: userId,
            moderatorTag: `AutoBanNet (blacklist:${blackG})`,
            reason,
            guildName: member.guild.name
          });
          await sendLogToGuild(member.guild.id, out);
          break;
        }
      } catch (err) {
        console.warn(`Error checking blacklisted guild ${blackG}:`, err.message || err);
      }
    }
  } catch (err) {
    console.error("Error in guildMemberAdd handler:", err);
  }
});

client.on("guildCreate", async guild => {
  console.log(`Joined guild: ${guild.name} (${guild.id})`);
});

// ---------- Login ----------
client.login(process.env.TOKEN).catch(err => {
  console.error("Failed to login. Check TOKEN in .env:", err);
});