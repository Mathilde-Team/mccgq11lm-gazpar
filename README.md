# mccgq11lm_gazpar — Convertisseur externe Zigbee2MQTT

## Projet

Convertisseur externe [Zigbee2MQTT](https://www.zigbee2mqtt.io/) pour le capteur **Aqara MCCGQ11LM** (porte/fenêtre).  
Ajoute un **mode compteur gaz Gazpar** : le capteur, câblé sur le compteur Gazpar, détecte les impulsions du contact sec et les convertit en m³ et kWh.

## Modification matérielle

Le compteur Gazpar dispose d'un **contact sec** (2 bornes) qui se ferme brièvement à chaque 0.01 m³ (10 litres) consommé. Le capteur Aqara MCCGQ11LM est modifié pour remplacer la détection magnétique (reed-switch) par un câblage filaire direct sur ce contact sec.

### Schéma de câblage

```
Capteur Aqara MCCGQ11LM                    Compteur Gazpar
    ┌───────────────────────┐                  ┌──────────────┐
    │                       │                  │              │
    │  VCC (3V pile)        │                  │              │
    │    │                  │                  │              │
    │    └── R 220kΩ ──┐    │                  │              │
    │                  │    │                  │              │
  ┌─│──D+ (data) ──────┘    │                  │              │
  │ │                       │                  │              │
  │ │  GND ─────────────────│─────fil GND──────│ Contact HAUT │
  │ │                       │                  │              │
  │ │                       │   ┌─fil data ────│ Contact BAS  │
  │ └───────────────────────┘   │              └──────────────┘
  └─────────────────────────────┘
```

### Détail des connexions

| Capteur Aqara | Fil      | Compteur Gazpar  |
| ------------- | -------- | ---------------- |
| **GND**       | fil GND  | **Contact HAUT** |
| **D+** (data) | fil data | **Contact BAS**  |

### Résistance pull-up

Une résistance de **220 kΩ** est soudée entre **VCC** et **D+** sur le PCB du capteur Aqara.  
Elle maintient D+ à l'état haut (contact ouvert) au repos. Quand le contact sec du Gazpar se ferme, D+ est tiré vers GND → le capteur détecte un changement d'état.

> **Note** : le signal transite sur le cluster Zigbee `genOnOff` (cluster 6) et non `ssIasZone`. Le convertisseur gère les deux cas.

## Fonctionnement logiciel

- **genOnOff / IAS Zone** — détection temps réel des impulsions (front montant `contact: false → true`)
- **Heartbeat Xiaomi** (~50 min) — rattrapage d'impulsions manquées via `trigger_count`
- **Anti-double-comptage** — marque `_ias_pulse_mark` pour éviter de compter 2× la même impulsion
- **Index éditable** — `gas_m3` peut être calé sur le relevé réel via l'interface Z2M

## Installation

```bash
# Copier dans Zigbee2MQTT
cp mccgq11lm_gazpar.js /path/to/zigbee2mqtt/data/external_converters/

# Ajouter dans configuration.yaml de Zigbee2MQTT
external_converters:
  - mccgq11lm_gazpar.js

# Redémarrer Zigbee2MQTT
```

## Configuration des appareils

```yaml
# configuration.yaml de Zigbee2MQTT

# Timeout disponibilité : 3× le heartbeat Aqara (~50 min)
availability:
    active:
        timeout: 200

devices:
    '0x00158d00XXXXXXXX':
        friendly_name: 'Contact Gazpar'
        device_options:
            gazpar_mode: true
            kwh_per_m3: 11.6 # PCS local GRDF
            liters_per_pulse: 10 # 10 L/impulsion (défaut Gazpar)

    '0x00158d00YYYYYYYY':
        friendly_name: 'Porte cuisine'
        # Pas de device_options → comportement porte standard

    '0x00158d00ZZZZZZZZ':
        friendly_name: 'Fenêtre chambre'
        device_options:
            window_mode: true # Présenter comme fenêtre
```

## Entités exposées

### Mode standard (porte/fenêtre)

| Entité               | Type   | Description                    |
| -------------------- | ------ | ------------------------------ |
| `contact`            | binary | État du contact (ouvert/fermé) |
| `battery`            | %      | Niveau batterie                |
| `voltage`            | mV     | Tension batterie               |
| `device_temperature` | °C     | Température interne capteur    |
| `elapsed`            | ms     | Temps depuis dernier événement |
| `power_outage_count` | count  | Coupures alimentation          |

### Mode Gazpar (en plus)

| Entité          | Type  | Description                        |
| --------------- | ----- | ---------------------------------- |
| `gas_m3`        | m³    | Index gaz cumulé (éditable)        |
| `gas_kwh`       | kWh   | Énergie gaz (PCS × m³)             |
| `gas_pulses`    | count | Nombre total d'impulsions comptées |
| `trigger_count` | count | Compteur interne capteur (absolu)  |

## Options

| Option             | Type  | Défaut | Description                   |
| ------------------ | ----- | ------ | ----------------------------- |
| `gazpar_mode`      | bool  | false  | Activer le comptage gaz       |
| `window_mode`      | bool  | false  | Présenter comme fenêtre       |
| `kwh_per_m3`       | float | 11.6   | PCS gaz local (kWh/m³)        |
| `liters_per_pulse` | int   | 10     | Volume par impulsion (litres) |

## Stabilité Aqara / Zigbee

Les MCCGQ11LM sont capricieux hors hub Aqara natif. Protections appliquées :

1. **`ota: false`** — désactive les vérifications OTA (re-join forcé)
2. **`configure: async () => {}`** — aucune commande ZCL standard envoyée

### Compatibilité Z2M 2.x / zhc 26.x

- Le cluster contact varie selon le firmware : `genOnOff` (cluster 6) ou `ssIasZone`. Le convertisseur gère les deux.
- Le champ `zoneStatus` peut arriver en minuscules (`zonestatus`) dans zigbee-herdsman récent — détection automatique.
- `withDeviceClass()` / `withStateClass()` n'existent pas dans zhc 26.x — les propriétés `device_class` et `state_class` sont assignées directement sur l'objet expose.
- `__meta.disableDefaultResponse` n'est pas interprété par Z2M 2.x (publié tel quel dans le payload MQTT). Le `disableDefaultResponse` est géré au niveau transport ZCL par zigbee-herdsman.

**Réseau** : préférer des routeurs IKEA Tradfri ou Sonoff proches des capteurs. Ne PAS utiliser de `debounce` en mode Gazpar (impulsions courtes ~200 ms).

## Socle qualité Mathilde-Team

Ce dépôt suit le [socle qualité de l'équipe](https://github.com/Mathilde-Team/.github/blob/main/SOCLE.md) :

- **`main`** (livraison) et **`dev`** (intégration) protégées. On n'y pousse jamais directement : PR vers `dev`, puis PR `dev` → `main`.
- **CI** : job « Qualité (lint, tests) », requis sur les deux branches (`.github/workflows/ci.yml`) — prettier, yamllint, tests Node avec couverture.
- **Garde** : `.github/workflows/guard-main.yml` refuse les PR vers `main` qui ne viennent pas de `dev`.
- **Mise à jour des PR** : `.github/workflows/maj-branches.yml` met à jour les PR vers `dev` à chaque avancée de `dev` (SOCLE §11). Label `pas-de-maj-auto` pour exclure une PR ; une PR `resolu-par-ia` repasse en brouillon : la relire avant _Ready for review_.
- **Protections versionnées** : `.github/branch-protection/{main,dev}.json`, vérifiées chaque jour par le workflow « Protection des branches ». Un administrateur les applique via `scripts/appliquer_socle.sh Mathilde-Team/mccgq11lm-gazpar`.
- **Version** : déclarée une seule fois, dans `package.json` (`version`), tag `vX.Y.Z` au commit de release (SOCLE §1).
- **Couverture des tests** : seuil bloquant de **95 %**, lignes et branches comprises (décision d'équipe du 21/10/2026, [.github#9](https://github.com/Mathilde-Team/.github/issues/9)). Dépôt sans test : le seuil part de la mesure du jour dans `package.json` (script `test:coverage`, options `--test-coverage-*`) et monte à chaque PR de tests (issue #6) jusqu'à 95.
- **Licence** : MIT, exception documentée au socle (issue #4) — fichier `LICENSE` à la racine, champ `license` de `package.json`, entrée dans `audit-exceptions.json` du dépôt `.github`.

## Licence

MIT — texte officiel dans le fichier [`LICENSE`](LICENSE).

Exception assumée au [socle qualité de l'équipe](https://github.com/Mathilde-Team/.github/blob/main/SOCLE.md) (§1 : GPL-3.0-or-later par défaut) : ce convertisseur est une création originale diffusée dans l'écosystème Zigbee2MQTT (MIT), sans emprunt de code GPL ; sa seule dépendance, `zigbee-herdsman-converters`, est MIT. L'exception est consignée dans `audit-exceptions.json` du dépôt [`.github`](https://github.com/Mathilde-Team/.github) (issue #4).
