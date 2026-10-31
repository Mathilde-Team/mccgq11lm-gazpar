// SPDX-License-Identifier: MIT
'use strict';

/**
 * Convertisseur externe Zigbee2MQTT — Aqara MCCGQ11LM universel
 * ==============================================================
 * Capteurs porte/fenêtre  → comportement standard (contact, batterie, temp.)
 * Capteur Gazpar           → compteur gaz (m³, kWh) en plus
 *
 * ── STABILITÉ ──────────────────────────────────────────────────
 * Les MCCGQ11LM sont capricieux hors hub Aqara natif.
 * Ce convertisseur applique plusieurs protections :
 *
 *   1. ota: false          — désactive les vérifications OTA qui
 *                            peuvent provoquer un re-join forcé
 *
 *   2. configure minimal   — n'envoie AUCUNE commande ZCL standard
 *                            (configure reporting, read attributes…)
 *                            que le capteur ne supporte pas et qui
 *                            peuvent déclencher un décrochage
 *
 *   3. disableDefaultRsp   — supprime la réponse automatique Z2M
 *                            aux attributeReport Xiaomi (0xFF01)
 *                            qui peut déstabiliser le capteur
 *
 *   4. elapsed             — exposé pour surveiller les heartbeats
 *                            (le capteur envoie un heartbeat ~50 min)
 *
 * ── CONFIGURATION YAML RECOMMANDÉE ─────────────────────────────
 *
 *   # Timeout disponibilité : 3× le heartbeat Aqara (~50 min)
 *   # Section racine de configuration.yaml :
 *   availability:
 *     active:
 *       timeout: 200        # minutes — offline si rien reçu depuis 200 min
 *
 *   devices:
 *     '0x00158d0004448cda':
 *       friendly_name: 'Contact Gazpar'
 *       device_options:
 *         gazpar_mode: true
 *         kwh_per_m3: 11.6
 *         liters_per_pulse: 10
 *
 *     '0xXXXXXXXXXXXXXXXX':
 *       friendly_name: 'Porte cuisine'
 *       # Pas de device_options → comportement porte standard
 *
 * ── RÉSEAU ZIGBEE ───────────────────────────────────────────────
 *   - Aqara end-devices évitent les routeurs non-Lumi/Aqara
 *   - Préférer des routeurs IKEA Tradfri ou Sonoff BASICZBR3
 *     proches des capteurs si décrochages fréquents
 *   - Ne PAS utiliser debounce sur le capteur Gazpar
 *     (risque de perdre des impulsions courtes ~200 ms)
 *
 * ==============================================================
 * Installation : data/external_converters/mccgq11lm_gazpar.js
 */

const exposes = require('zigbee-herdsman-converters/lib/exposes');
const ea = exposes.access;

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function getParams(options) {
    return {
        litersPerPulse: (options && options.liters_per_pulse) || 10,
        m3PerPulse: ((options && options.liters_per_pulse) || 10) / 1000,
        kwhPerM3: (options && options.kwh_per_m3) || 11.6,
    };
}

function computeFromPulses(totalPulses, m3PerPulse, kwhPerM3) {
    const m3 = Math.round(totalPulses * m3PerPulse * 1000) / 1000;
    const kwh = Math.round(m3 * kwhPerM3 * 100) / 100;
    return { gas_pulses: totalPulses, gas_m3: m3, gas_kwh: kwh };
}

// ─── CONVERTISSEUR IAS (temps réel) ──────────────────────────────────────────
// Déclenché à chaque changement d'état du reed-switch.
// Front montant uniquement (false→true) pour ne compter qu'une fois
// par impulsion Gazpar (l'aller et le retour de l'aimant sinon = 2 events).
const fromZigbeeIAS = {
    cluster: 'ssIasZone',
    type: ['attributeReport', 'commandStatusChangeNotification'],
    convert: (model, msg, publish, options, meta) => {
        const log = meta.logger || console;
        log.debug(
            `[GAZPAR-IAS] msg.type=${msg.type} msg.data keys=${JSON.stringify(Object.keys(msg.data))} msg.data=${JSON.stringify(msg.data)}`,
        );
        log.debug(`[GAZPAR-IAS] options=${JSON.stringify(options)}`);

        const isGazpar = options && options.gazpar_mode;
        const zoneStatus = 'zonestatus' in msg.data ? msg.data.zonestatus : msg.data.zoneStatus;
        log.debug(
            `[GAZPAR-IAS] zoneStatus=${zoneStatus} (from '${'zonestatus' in msg.data ? 'zonestatus' : 'zoneStatus'}')`,
        );
        if (zoneStatus === undefined) {
            log.debug('[GAZPAR-IAS] zoneStatus undefined, returning');
            return;
        }
        const contact = (zoneStatus & 1) === 0;
        const prevContact = meta.state.contact;
        const result = { contact };
        log.debug(`[GAZPAR-IAS] contact=${contact} prevContact=${prevContact} isGazpar=${isGazpar}`);

        if (isGazpar && contact === true && prevContact === false) {
            const { m3PerPulse, kwhPerM3 } = getParams(options);
            const pulses = (meta.state.gas_pulses || 0) + 1;
            log.debug(`[GAZPAR-IAS] PULSE DETECTED! pulses=${pulses}`);

            // Marque anti-double-comptage avec trigger_count du heartbeat
            result._ias_pulse_mark = meta.state._raw_trigger_count;
            Object.assign(result, computeFromPulses(pulses, m3PerPulse, kwhPerM3));
        }

        return result;
    },
};

// ─── CONVERTISSEUR genOnOff (variante firmware) ──────────────────────────────
// Certains MCCGQ11LM utilisent genOnOff (cluster 6) au lieu de ssIasZone
// pour signaler l'état du contact. onOff=0 → contact fermé, onOff=1 → contact ouvert.
const fromZigbeeOnOff = {
    cluster: 'genOnOff',
    type: ['attributeReport', 'readResponse'],
    convert: (model, msg, publish, options, meta) => {
        const log = meta.logger || console;
        log.debug(`[GAZPAR-ONOFF] msg.type=${msg.type} msg.data=${JSON.stringify(msg.data)}`);

        const isGazpar = options && options.gazpar_mode;
        // onOff=0 → contact fermé (true), onOff=1 → contact ouvert (false)
        const contact = msg.data.onOff === 0;
        const prevContact = meta.state.contact;
        const result = { contact };
        log.debug(`[GAZPAR-ONOFF] contact=${contact} prevContact=${prevContact} isGazpar=${isGazpar}`);

        if (isGazpar && contact === true && prevContact === false) {
            const { m3PerPulse, kwhPerM3 } = getParams(options);
            const pulses = (meta.state.gas_pulses || 0) + 1;
            log.debug(`[GAZPAR-ONOFF] PULSE DETECTED! pulses=${pulses}`);

            result._ias_pulse_mark = meta.state._raw_trigger_count;
            Object.assign(result, computeFromPulses(pulses, m3PerPulse, kwhPerM3));
        }

        return result;
    },
};

// ─── CONVERTISSEUR XIAOMI HEARTBEAT (~50 min) ─────────────────────────────────
// L'attribut propriétaire 0xFF01 (tag 65281) transporte en un seul message :
//   tag 0x01 (1)   → tension batterie mV
//   tag 0x03 (3)   → température interne °C
//   tag 0x05 (5)   → compteur coupures alimentation
//   tag 0x0A (10)  → elapsed ms depuis dernier événement contact
//   tag 0x64 (100) → trigger_count absolu (RAZ au remplacement pile)
//
// STABILITÉ — __meta.disableDefaultResponse: true
//   Z2M envoie normalement un DefaultResponse ZCL après chaque attributeReport.
//   Sur l'attribut propriétaire Aqara 0xFF01, ce DefaultResponse est inattendu
//   et peut déclencher un re-join ou un silence prolongé du capteur.
//   Ce flag demande à Z2M de ne PAS répondre à ce message particulier.
const fromZigbeeXiaomi = {
    cluster: 'genBasic',
    type: ['attributeReport', 'readResponse'],
    convert: (model, msg, publish, options, meta) => {
        const log = meta.logger || console;
        log.debug(`[GAZPAR-XIAOMI] msg.type=${msg.type} msg.data keys=${JSON.stringify(Object.keys(msg.data))}`);

        const isGazpar = options && options.gazpar_mode;
        const result = {};
        const raw = msg.data['65281']; // 0xFF01
        if (!raw) {
            log.debug('[GAZPAR-XIAOMI] no 65281 data, returning');
            return result;
        }
        log.debug(`[GAZPAR-XIAOMI] raw keys=${JSON.stringify(Object.keys(raw))} isGazpar=${isGazpar}`);

        // Tension & batterie
        if (raw['1'] !== undefined) {
            const mv = raw['1'];
            result.voltage = mv;
            result.battery = Math.min(100, Math.max(0, Math.round(((mv - 2500) / (3100 - 2500)) * 100)));
        }

        // Température interne
        if (raw['3'] !== undefined) {
            result.device_temperature = raw['3'];
        }

        // Coupures alimentation
        if (raw['5'] !== undefined) {
            result.power_outage_count = raw['5'];
        }

        // Elapsed : ms depuis le dernier événement contact
        // Un elapsed très grand (> 3× la période habituelle) signale
        // que le capteur a peut-être manqué une impulsion Gazpar
        if (raw['10'] !== undefined) {
            result.elapsed = raw['10'];
        }

        // trigger_count absolu — rattrapage impulsions manquées (mode Gazpar)
        if (isGazpar && raw['100'] !== undefined) {
            const newTC = raw['100'];
            const prevTC = meta.state._raw_trigger_count;

            result._raw_trigger_count = newTC;
            result.trigger_count = newTC;

            if (prevTC !== undefined && newTC !== prevTC) {
                const { m3PerPulse, kwhPerM3 } = getParams(options);
                let missed = 0;

                if (newTC > prevTC) {
                    missed = newTC - prevTC;
                } else {
                    // Diminution = pile remplacée, repartir depuis newTC
                    missed = newTC;
                }

                if (missed > 0) {
                    const alreadyCounted = prevTC === meta.state._ias_pulse_mark ? missed : 0;
                    const toAdd = missed - alreadyCounted;

                    if (toAdd > 0) {
                        const pulses = (meta.state.gas_pulses || 0) + toAdd;
                        Object.assign(result, computeFromPulses(pulses, m3PerPulse, kwhPerM3));
                    }
                }
            } else if (prevTC === undefined) {
                result._ias_pulse_mark = newTC;
            }
        }

        return result;
    },
};

// ─── toZigbee : initialisation index ─────────────────────────────────────────
const toZigbeeSetM3 = {
    key: ['gas_m3'],
    convertSet: async (entity, key, value, meta) => {
        const options = meta.options || {};
        const { m3PerPulse, kwhPerM3 } = getParams(options);
        const m3 = Math.round(parseFloat(value) * 1000) / 1000;
        const pulses = Math.round(m3 / m3PerPulse);
        const kwh = Math.round(m3 * kwhPerM3 * 100) / 100;
        return {
            state: { gas_m3: m3, gas_kwh: kwh, gas_pulses: pulses },
        };
    },
};

// ─── EXPOSES dynamiques ───────────────────────────────────────────────────────
function buildExposes(device, options) {
    const isGazpar = options && options.gazpar_mode;
    const isWindow = options && options.window_mode;

    const contactLabel = isGazpar
        ? 'Aimant détecté (impulsion en cours)'
        : isWindow
          ? 'Fenêtre ouverte'
          : 'Porte ouverte';
    const deviceClass = isWindow ? 'window' : 'door';

    const base = [
        exposes.binary('contact', ea.STATE, true, false).withDescription(contactLabel),
        exposes
            .numeric('device_temperature', ea.STATE)
            .withUnit('°C')
            .withDescription('Température interne du capteur'),
        exposes.numeric('battery', ea.STATE).withUnit('%').withDescription('Niveau batterie'),
        exposes.numeric('voltage', ea.STATE).withUnit('mV').withDescription('Tension batterie'),
        exposes
            .numeric('elapsed', ea.STATE)
            .withUnit('ms')
            .withDescription('Temps depuis dernier événement — heartbeat toutes ~50 min'),
        exposes.numeric('power_outage_count', ea.STATE).withDescription('Nombre de coupures alimentation détectées'),
    ];

    if (isGazpar) {
        const kwhPerM3 = (options && options.kwh_per_m3) || 11.6;
        const gasM3 = exposes
            .numeric('gas_m3', ea.STATE_SET)
            .withUnit('m³')
            .withValueMin(0)
            .withValueStep(0.01)
            .withDescription('Index gaz — éditable pour caler sur relevé réel');
        gasM3.device_class = 'gas';
        gasM3.state_class = 'total_increasing';

        const gasKwh = exposes
            .numeric('gas_kwh', ea.STATE)
            .withUnit('kWh')
            .withDescription(`Énergie gaz (PCS = ${kwhPerM3} kWh/m³)`);
        gasKwh.device_class = 'energy';
        gasKwh.state_class = 'total_increasing';

        base.push(
            gasM3,
            gasKwh,
            exposes.numeric('gas_pulses', ea.STATE).withDescription("Nombre total d'impulsions comptées"),
            exposes
                .numeric('trigger_count', ea.STATE)
                .withDescription('Compteur interne capteur (absolu, RAZ au remplacement pile)'),
        );
    }

    return base;
}

// ─── DÉFINITION ──────────────────────────────────────────────────────────────
const definition = {
    fingerprint: [{ modelID: 'lumi.sensor_magnet.aq2', manufacturerName: 'LUMI' }],
    model: 'MCCGQ11LM',
    vendor: 'LUMI',
    description: 'Aqara door/window sensor (+ mode compteur Gazpar optionnel)',
    fromZigbee: [fromZigbeeIAS, fromZigbeeOnOff, fromZigbeeXiaomi],
    toZigbee: [toZigbeeSetM3],
    exposes: buildExposes,

    // STABILITÉ : désactiver OTA.
    // Les vérifications OTA envoient des trames que le firmware Aqara
    // peut interpréter comme une demande de reset ou de re-join forcé.
    ota: false,

    // STABILITÉ : configure intentionnellement vide.
    // Z2M tenterait sinon d'envoyer des commandes ZCL standard
    // (configure reporting, genPowerCfg bind, ssIasZone write CIE address…)
    // que l'Aqara ne supporte pas proprement → décrochage au premier join.
    // L'enrôlement de la zone IAS est géré automatiquement par Z2M
    // côté coordinateur sans action de notre part.
    configure: async () => {},

    options: [
        exposes.binary('gazpar_mode', ea.SET, true, false).withDescription('Activer le mode compteur gaz Gazpar'),
        exposes
            .binary('window_mode', ea.SET, true, false)
            .withDescription('Présenter comme capteur de fenêtre (au lieu de porte)'),
        exposes
            .numeric('kwh_per_m3', ea.SET)
            .withValueMin(8)
            .withValueMax(14)
            .withValueStep(0.01)
            .withUnit('kWh/m³')
            .withDescription('PCS local GRDF (défaut 11.6 kWh/m³)'),
        exposes
            .numeric('liters_per_pulse', ea.SET)
            .withValueMin(1)
            .withValueMax(100)
            .withValueStep(1)
            .withUnit('L')
            .withDescription('Litres par impulsion (défaut 10 L) — ne pas utiliser debounce en mode Gazpar'),
    ],
};

module.exports = definition;
