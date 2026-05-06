const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT      = 8888;
const ZONE_LAT  = 41.32274268047485;
const ZONE_LON  = 2.1520313218071245;
const RADIUS_NM = 40;

// ── ADS-B source: adsb.lol — real-time, same format as adsb.one ──────
const ADSB_URL = `https://api.adsb.lol/v2/point/${ZONE_LAT}/${ZONE_LON}/${RADIUS_NM}`;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'BCNWindowTracker/1.0' } }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        if (res.statusCode === 403) { reject(new Error(`403 from ${url}`)); return; }
        try { resolve(JSON.parse(raw)); }
        catch(e) { reject(new Error('Bad JSON from upstream')); }
      });
    }).on('error', reject);
  });
}

// ── METAR / active runway ─────────────────────────────────────────
const METAR_URL      = 'https://aviationweather.gov/api/data/metar?ids=LEBL&format=json';
const METAR_TTL      = 30 * 60 * 1000;
let   metarCache     = null;
let   metarFetchedAt = 0;

async function getActiveRunway() {
  if (metarCache && Date.now() - metarFetchedAt < METAR_TTL) return metarCache;
  try {
    const data = await fetchJson(METAR_URL);
    const obs  = Array.isArray(data) ? data[0] : null;
    if (!obs) throw new Error('No METAR data');

    const wdir  = typeof obs.wdir === 'number' ? obs.wdir : null;
    const wspd  = typeof obs.wspd === 'number' ? obs.wspd : 0;

    let runway = '25'; // default
    if (wdir !== null && wspd >= 3) {
      const diff07 = Math.abs(((wdir - 70)  + 360) % 360); const d07 = diff07 > 180 ? 360 - diff07 : diff07;
      const diff25 = Math.abs(((wdir - 250) + 360) % 360); const d25 = diff25 > 180 ? 360 - diff25 : diff25;
      runway = d07 < d25 ? '07' : '25';
    }

    const wind = wdir !== null ? { dir: wdir, speed: wspd, gust: obs.wgst || null } : null;
    metarCache = { runway, wind, raw: obs.rawOb || '', time: obs.obsTime || '' };
    metarFetchedAt = Date.now();
    console.log(`METAR: wind ${wdir ?? '?'}°/${wspd}kt → runway ${runway}`);
    return metarCache;
  } catch(e) {
    console.error('METAR fetch failed:', e.message);
    return metarCache || { runway: '25', wind: null, raw: '', time: '' };
  }
}

// ── Aircraft photo (Planespotters.net) ───────────────────────────
const photoCache = new Map();

async function lookupPhoto(hex) {
  const key = hex.toLowerCase();
  if (photoCache.has(key)) return photoCache.get(key);
  try {
    const data = await fetchJson(`https://api.planespotters.net/pub/photos/hex/${key}`);
    const p = data?.photos?.[0] ?? null;
    const result = p ? {
      url:          p.thumbnail_large?.src || p.thumbnail?.src || null,
      link:         p.link || null,
      photographer: p.photographer || null,
    } : null;
    photoCache.set(key, result);
    setTimeout(() => photoCache.delete(key), 7 * 24 * 3600 * 1000);
    return result;
  } catch {
    photoCache.set(key, null);
    setTimeout(() => photoCache.delete(key), 3600 * 1000);
    return null;
  }
}

// ── Airport ICAO → { iata, city, lat, lon } ──────────────────────
const AIRPORTS = {
  // Italy
  LIPE:{ iata:'BLQ', city:'Bologna',           lat:44.535,  lon:11.289  },
  LIRF:{ iata:'FCO', city:'Rome',              lat:41.800,  lon:12.239  },
  LIMC:{ iata:'MXP', city:'Milan',             lat:45.630,  lon:8.723   },
  LIME:{ iata:'BGY', city:'Milan Bergamo',     lat:45.674,  lon:9.704   },
  LIML:{ iata:'LIN', city:'Milan Linate',      lat:45.445,  lon:9.277   },
  LIPZ:{ iata:'VCE', city:'Venice',            lat:45.505,  lon:12.352  },
  LIBD:{ iata:'BRI', city:'Bari',              lat:41.138,  lon:16.761  },
  LICC:{ iata:'CTA', city:'Catania',           lat:37.467,  lon:15.066  },
  LICJ:{ iata:'PMO', city:'Palermo',           lat:38.176,  lon:13.091  },
  LIRN:{ iata:'NAP', city:'Naples',            lat:40.886,  lon:14.291  },
  LIEE:{ iata:'CAG', city:'Cagliari',          lat:39.251,  lon:9.054   },
  LIEA:{ iata:'AHO', city:'Alghero',           lat:40.632,  lon:8.291   },
  LIBP:{ iata:'PSR', city:'Pescara',           lat:42.432,  lon:14.181  },
  LIRQ:{ iata:'FLR', city:'Florence',          lat:43.810,  lon:11.205  },
  LIPQ:{ iata:'TRS', city:'Trieste',           lat:45.827,  lon:13.472  },
  LIPH:{ iata:'TSF', city:'Treviso',           lat:45.648,  lon:12.194  },
  LIBR:{ iata:'BDS', city:'Brindisi',          lat:40.657,  lon:17.947  },

  // United Kingdom
  EGLL:{ iata:'LHR', city:'London',            lat:51.477,  lon:-0.461  },
  EGKK:{ iata:'LGW', city:'London Gatwick',    lat:51.148,  lon:-0.190  },
  EGSS:{ iata:'STN', city:'London Stansted',   lat:51.885,  lon:0.235   },
  EGGW:{ iata:'LTN', city:'London Luton',      lat:51.875,  lon:-0.368  },
  EGCC:{ iata:'MAN', city:'Manchester',        lat:53.354,  lon:-2.275  },
  EGBB:{ iata:'BHX', city:'Birmingham',        lat:52.454,  lon:-1.748  },
  EGNX:{ iata:'EMA', city:'East Midlands',     lat:52.831,  lon:-1.328  },
  EGPH:{ iata:'EDI', city:'Edinburgh',         lat:55.950,  lon:-3.373  },
  EGPF:{ iata:'GLA', city:'Glasgow',           lat:55.872,  lon:-4.433  },
  EGGD:{ iata:'BRS', city:'Bristol',           lat:51.382,  lon:-2.719  },
  EGNT:{ iata:'NCL', city:'Newcastle',         lat:55.038,  lon:-1.692  },
  EGNM:{ iata:'LBA', city:'Leeds Bradford',    lat:53.866,  lon:-1.661  },

  // France
  LFPG:{ iata:'CDG', city:'Paris',             lat:49.010,  lon:2.548   },
  LFPO:{ iata:'ORY', city:'Paris Orly',        lat:48.723,  lon:2.379   },
  LFMN:{ iata:'NCE', city:'Nice',              lat:43.658,  lon:7.216   },
  LFML:{ iata:'MRS', city:'Marseille',         lat:43.439,  lon:5.221   },
  LFBO:{ iata:'TLS', city:'Toulouse',          lat:43.629,  lon:1.368   },
  LFLL:{ iata:'LYS', city:'Lyon',              lat:45.726,  lon:5.091   },
  LFRN:{ iata:'RNS', city:'Rennes',            lat:48.069,  lon:-1.731  },
  LFBD:{ iata:'BOD', city:'Bordeaux',          lat:44.829,  lon:-0.715  },
  LFRS:{ iata:'NTE', city:'Nantes',            lat:47.153,  lon:-1.611  },
  LFST:{ iata:'SXB', city:'Strasbourg',        lat:48.538,  lon:7.628   },

  // Germany
  EDDM:{ iata:'MUC', city:'Munich',            lat:48.354,  lon:11.786  },
  EDDB:{ iata:'BER', city:'Berlin',            lat:52.367,  lon:13.503  },
  EDDF:{ iata:'FRA', city:'Frankfurt',         lat:50.033,  lon:8.571   },
  EDDH:{ iata:'HAM', city:'Hamburg',           lat:53.630,  lon:9.988   },
  EDDS:{ iata:'STR', city:'Stuttgart',         lat:48.690,  lon:9.222   },
  EDDL:{ iata:'DUS', city:'Düsseldorf',        lat:51.289,  lon:6.767   },
  EDDK:{ iata:'CGN', city:'Cologne',           lat:50.866,  lon:7.143   },
  EDDN:{ iata:'NUE', city:'Nuremberg',         lat:49.499,  lon:11.078  },
  EDDP:{ iata:'LEJ', city:'Leipzig',           lat:51.432,  lon:12.241  },

  // Netherlands / Belgium / Luxembourg
  EHAM:{ iata:'AMS', city:'Amsterdam',         lat:52.309,  lon:4.764   },
  EHRD:{ iata:'RTM', city:'Rotterdam',         lat:51.957,  lon:4.437   },
  EHBK:{ iata:'MST', city:'Maastricht',        lat:50.912,  lon:5.770   },
  EBBR:{ iata:'BRU', city:'Brussels',          lat:50.901,  lon:4.484   },
  EBCI:{ iata:'CRL', city:'Brussels South',    lat:50.459,  lon:4.453   },
  ELLX:{ iata:'LUX', city:'Luxembourg',        lat:49.627,  lon:6.212   },

  // Switzerland / Austria
  LSZH:{ iata:'ZRH', city:'Zurich',            lat:47.465,  lon:8.549   },
  LSGG:{ iata:'GVA', city:'Geneva',            lat:46.238,  lon:6.109   },
  LSZB:{ iata:'BRN', city:'Bern',              lat:46.914,  lon:7.497   },
  LOWW:{ iata:'VIE', city:'Vienna',            lat:48.110,  lon:16.570  },
  LOWI:{ iata:'INN', city:'Innsbruck',         lat:47.260,  lon:11.344  },
  LOWS:{ iata:'SZG', city:'Salzburg',          lat:47.794,  lon:13.004  },

  // Scandinavia
  EKCH:{ iata:'CPH', city:'Copenhagen',        lat:55.618,  lon:12.656  },
  ESSA:{ iata:'ARN', city:'Stockholm',         lat:59.652,  lon:17.919  },
  ENGM:{ iata:'OSL', city:'Oslo',              lat:60.194,  lon:11.100  },
  EFHK:{ iata:'HEL', city:'Helsinki',          lat:60.317,  lon:24.963  },
  ESGG:{ iata:'GOT', city:'Gothenburg',        lat:57.668,  lon:12.292  },
  ESMS:{ iata:'MMX', city:'Malmö',             lat:55.537,  lon:13.376  },
  ENVA:{ iata:'TRD', city:'Trondheim',         lat:63.458,  lon:10.924  },
  ENZV:{ iata:'SVG', city:'Stavanger',         lat:58.877,  lon:5.638   },
  ENBR:{ iata:'BGO', city:'Bergen',            lat:60.294,  lon:5.218   },
  EKBI:{ iata:'BLL', city:'Billund',           lat:55.740,  lon:9.152   },
  ESPA:{ iata:'LLA', city:'Luleå',             lat:65.544,  lon:22.122  },
  ESNN:{ iata:'SDL', city:'Sundsvall',         lat:62.528,  lon:17.444  },
  ESKN:{ iata:'NYO', city:'Stockholm Skavsta', lat:58.789,  lon:16.912  },
  ENRY:{ iata:'RYG', city:'Oslo Rygge',        lat:59.379,  lon:10.786  },

  // Eastern Europe & Baltic
  EPWA:{ iata:'WAW', city:'Warsaw',            lat:52.166,  lon:20.967  },
  EPKK:{ iata:'KRK', city:'Krakow',            lat:50.078,  lon:19.785  },
  EPGD:{ iata:'GDN', city:'Gdansk',            lat:54.378,  lon:18.466  },
  EPPO:{ iata:'POZ', city:'Poznan',            lat:52.421,  lon:16.826  },
  EPWR:{ iata:'WRO', city:'Wroclaw',           lat:51.103,  lon:16.886  },
  EVRA:{ iata:'RIX', city:'Riga',              lat:56.924,  lon:23.971  },
  EYVI:{ iata:'VNO', city:'Vilnius',           lat:54.635,  lon:25.288  },
  EETN:{ iata:'TLL', city:'Tallinn',           lat:59.413,  lon:24.833  },
  LKPR:{ iata:'PRG', city:'Prague',            lat:50.101,  lon:14.260  },
  LHBP:{ iata:'BUD', city:'Budapest',          lat:47.437,  lon:19.261  },
  LROP:{ iata:'OTP', city:'Bucharest',         lat:44.572,  lon:26.102  },
  LZIB:{ iata:'BTS', city:'Bratislava',        lat:48.170,  lon:17.213  },

  // Balkans
  LDZA:{ iata:'ZAG', city:'Zagreb',            lat:45.743,  lon:16.069  },
  LJLJ:{ iata:'LJU', city:'Ljubljana',         lat:46.224,  lon:14.458  },
  LYBE:{ iata:'BEG', city:'Belgrade',          lat:44.818,  lon:20.309  },
  LBSF:{ iata:'SOF', city:'Sofia',             lat:42.697,  lon:23.411  },
  LYPG:{ iata:'TGD', city:'Podgorica',         lat:42.360,  lon:19.252  },
  LQSA:{ iata:'SJJ', city:'Sarajevo',          lat:43.825,  lon:18.332  },
  LWSK:{ iata:'SKP', city:'Skopje',            lat:41.961,  lon:21.621  },
  LDSP:{ iata:'SPU', city:'Split',             lat:43.539,  lon:16.298  },
  LATI:{ iata:'TIA', city:'Tirana',            lat:41.415,  lon:19.721  },
  LGTS:{ iata:'SKG', city:'Thessaloniki',      lat:40.520,  lon:22.971  },

  // Greece
  LGAV:{ iata:'ATH', city:'Athens',            lat:37.936,  lon:23.944  },
  LGRP:{ iata:'RHO', city:'Rhodes',            lat:36.405,  lon:28.086  },
  LGIR:{ iata:'HER', city:'Heraklion',         lat:35.339,  lon:25.180  },
  LGKF:{ iata:'EFL', city:'Cephalonia',        lat:38.120,  lon:20.500  },
  LGKR:{ iata:'CFU', city:'Corfu',             lat:39.602,  lon:19.912  },
  LGMK:{ iata:'JMK', city:'Mykonos',           lat:37.436,  lon:25.349  },
  LGSR:{ iata:'JTR', city:'Santorini',         lat:36.399,  lon:25.479  },
  LGZA:{ iata:'ZTH', city:'Zakynthos',         lat:37.751,  lon:20.884  },

  // Iberia
  LEMD:{ iata:'MAD', city:'Madrid',            lat:40.472,  lon:-3.561  },
  LEPA:{ iata:'PMI', city:'Palma',             lat:39.552,  lon:2.739   },
  GCLP:{ iata:'LPA', city:'Las Palmas',        lat:27.932,  lon:-15.387 },
  GCTS:{ iata:'TFS', city:'Tenerife Sur',      lat:28.045,  lon:-16.573 },
  GCFV:{ iata:'FUE', city:'Fuerteventura',     lat:28.453,  lon:-13.864 },
  GCRR:{ iata:'ACE', city:'Lanzarote',         lat:28.945,  lon:-13.606 },
  GCXO:{ iata:'TFN', city:'Tenerife Norte',    lat:28.483,  lon:-16.342 },
  GCHI:{ iata:'FUE', city:'Hierro',            lat:27.815,  lon:-17.887 },
  GCGM:{ iata:'GMZ', city:'La Gomera',         lat:28.030,  lon:-17.215 },
  GCLM:{ iata:'SPC', city:'La Palma',          lat:28.626,  lon:-17.756 },
  LEZL:{ iata:'SVQ', city:'Seville',           lat:37.418,  lon:-5.893  },
  LEVD:{ iata:'VLL', city:'Valladolid',        lat:41.706,  lon:-4.852  },
  LEBB:{ iata:'BIO', city:'Bilbao',            lat:43.301,  lon:-2.911  },
  LECO:{ iata:'LCG', city:'A Coruña',          lat:43.302,  lon:-8.377  },
  LEVX:{ iata:'VGO', city:'Vigo',              lat:42.232,  lon:-8.627  },
  LERJ:{ iata:'ZAZ', city:'Zaragoza',          lat:41.666,  lon:-1.042  },
  LEAM:{ iata:'LEI', city:'Almeria',           lat:36.845,  lon:-2.370  },
  LEMH:{ iata:'MAH', city:'Menorca',           lat:39.863,  lon:4.219   },
  LEIB:{ iata:'IBZ', city:'Ibiza',             lat:38.873,  lon:1.374   },
  LERS:{ iata:'REU', city:'Reus',              lat:41.147,  lon:1.167   },
  LEVC:{ iata:'VLC', city:'Valencia',          lat:39.490,  lon:-0.482  },
  LEAL:{ iata:'ALC', city:'Alicante',          lat:38.282,  lon:-0.558  },
  LEGR:{ iata:'GRX', city:'Granada',           lat:37.189,  lon:-3.777  },
  LEMG:{ iata:'AGP', city:'Malaga',            lat:36.675,  lon:-4.499  },
  LPPT:{ iata:'LIS', city:'Lisbon',            lat:38.774,  lon:-9.135  },
  LPPR:{ iata:'OPO', city:'Porto',             lat:41.235,  lon:-8.678  },
  LPFR:{ iata:'FAO', city:'Faro',              lat:37.014,  lon:-7.966  },

  // N Africa
  DAAG:{ iata:'ALG', city:'Algiers',           lat:36.691,  lon:3.215   },
  DTTA:{ iata:'TUN', city:'Tunis',             lat:36.851,  lon:10.227  },
  DTTJ:{ iata:'DJE', city:'Djerba',            lat:33.875,  lon:10.776  },
  DTMB:{ iata:'MIR', city:'Monastir',          lat:35.758,  lon:10.755  },
  DTNH:{ iata:'NBE', city:'Enfidha',           lat:36.073,  lon:10.438  },
  GMME:{ iata:'RBA', city:'Rabat',             lat:34.051,  lon:-6.752  },
  GMMN:{ iata:'CMN', city:'Casablanca',        lat:33.368,  lon:-7.590  },
  GMMX:{ iata:'RAK', city:'Marrakech',         lat:31.607,  lon:-8.036  },
  GMAD:{ iata:'AGA', city:'Agadir',            lat:30.325,  lon:-9.413  },
  GMFN:{ iata:'NDR', city:'Nador',             lat:34.989,  lon:-3.028  },
  GMFO:{ iata:'OUD', city:'Oujda',             lat:34.787,  lon:-1.924  },
  GMTT:{ iata:'TNG', city:'Tangier',           lat:35.726,  lon:-5.916  },
  HECA:{ iata:'CAI', city:'Cairo',             lat:30.122,  lon:31.406  },

  // Middle East
  OMDB:{ iata:'DXB', city:'Dubai',             lat:25.253,  lon:55.364  },
  OMAA:{ iata:'AUH', city:'Abu Dhabi',         lat:24.433,  lon:54.651  },
  OERK:{ iata:'RUH', city:'Riyadh',            lat:24.958,  lon:46.699  },
  OEDF:{ iata:'DMM', city:'Dammam',            lat:26.471,  lon:49.798  },
  OEJN:{ iata:'JED', city:'Jeddah',            lat:21.680,  lon:39.157  },
  OTHH:{ iata:'DOH', city:'Doha',              lat:25.274,  lon:51.608  },
  OKBK:{ iata:'KWI', city:'Kuwait',            lat:29.227,  lon:47.969  },
  LLBG:{ iata:'TLV', city:'Tel Aviv',          lat:32.011,  lon:34.887  },
  OJAM:{ iata:'AMM', city:'Amman',             lat:31.723,  lon:35.993  },
  OLBA:{ iata:'BEY', city:'Beirut',            lat:33.821,  lon:35.488  },
  OIIE:{ iata:'IKA', city:'Tehran',            lat:35.416,  lon:51.152  },
  OMSJ:{ iata:'SHJ', city:'Sharjah',           lat:25.329,  lon:55.517  },
  OMFM:{ iata:'MCT', city:'Muscat',            lat:23.593,  lon:58.285  },
  OEAH:{ iata:'AHB', city:'Abha',              lat:18.240,  lon:42.657  },

  // Russia / Central Asia
  UUEE:{ iata:'SVO', city:'Moscow',            lat:55.973,  lon:37.415  },
  UUDD:{ iata:'DME', city:'Moscow Domodedovo', lat:55.410,  lon:37.906  },
  ULLI:{ iata:'LED', city:'St Petersburg',     lat:59.800,  lon:30.263  },
  URSS:{ iata:'AER', city:'Sochi',             lat:43.450,  lon:39.957  },
  UTTT:{ iata:'TAS', city:'Tashkent',          lat:41.258,  lon:69.281  },
  UAAA:{ iata:'ALA', city:'Almaty',            lat:43.353,  lon:77.041  },

  // Asia-Pacific
  VHHH:{ iata:'HKG', city:'Hong Kong',         lat:22.309,  lon:113.915 },
  ZBAA:{ iata:'PEK', city:'Beijing',           lat:40.072,  lon:116.588 },
  ZSPD:{ iata:'PVG', city:'Shanghai',          lat:31.144,  lon:121.805 },
  ZUUU:{ iata:'CTU', city:'Chengdu',           lat:30.579,  lon:103.947 },
  ZSSS:{ iata:'SHA', city:'Shanghai Hongqiao', lat:31.198,  lon:121.336 },
  WSSS:{ iata:'SIN', city:'Singapore',         lat:1.359,   lon:103.989 },
  WMKK:{ iata:'KUL', city:'Kuala Lumpur',      lat:2.746,   lon:101.710 },
  VTBS:{ iata:'BKK', city:'Bangkok',           lat:13.681,  lon:100.748 },
  RJTT:{ iata:'HND', city:'Tokyo',             lat:35.549,  lon:139.780 },
  RJAA:{ iata:'NRT', city:'Tokyo Narita',      lat:35.765,  lon:140.386 },
  RKSI:{ iata:'ICN', city:'Seoul',             lat:37.460,  lon:126.441 },
  RPLL:{ iata:'MNL', city:'Manila',            lat:14.509,  lon:121.020 },
  VABB:{ iata:'BOM', city:'Mumbai',            lat:19.089,  lon:72.868  },
  VIDP:{ iata:'DEL', city:'Delhi',             lat:28.556,  lon:77.101  },

  // Americas
  KJFK:{ iata:'JFK', city:'New York',          lat:40.640,  lon:-73.779 },
  KEWR:{ iata:'EWR', city:'New York Newark',   lat:40.693,  lon:-74.175 },
  KLAX:{ iata:'LAX', city:'Los Angeles',       lat:33.943,  lon:-118.408},
  KORD:{ iata:'ORD', city:'Chicago',           lat:41.978,  lon:-87.905 },
  KMIA:{ iata:'MIA', city:'Miami',             lat:25.796,  lon:-80.287 },
  KBOS:{ iata:'BOS', city:'Boston',            lat:42.366,  lon:-71.011 },
  KIAD:{ iata:'IAD', city:'Washington',        lat:38.945,  lon:-77.456 },
  KATL:{ iata:'ATL', city:'Atlanta',           lat:33.637,  lon:-84.428 },
  CYYZ:{ iata:'YYZ', city:'Toronto',           lat:43.677,  lon:-79.631 },
  CYVR:{ iata:'YVR', city:'Vancouver',         lat:49.195,  lon:-123.184},
  CYUL:{ iata:'YUL', city:'Montreal',          lat:45.458,  lon:-73.750 },
  SBGR:{ iata:'GRU', city:'São Paulo',         lat:-23.435, lon:-46.473 },
  SAEZ:{ iata:'EZE', city:'Buenos Aires',      lat:-34.822, lon:-58.536 },
  SCEL:{ iata:'SCL', city:'Santiago',          lat:-33.393, lon:-70.786 },
  SEQM:{ iata:'UIO', city:'Quito',             lat:-0.142,  lon:-78.488 },
  MMMX:{ iata:'MEX', city:'Mexico City',       lat:19.436,  lon:-99.072 },
  MDPC:{ iata:'PUJ', city:'Punta Cana',        lat:18.568,  lon:-68.364 },
  TBPB:{ iata:'BGI', city:'Barbados',          lat:13.075,  lon:-59.493 },
  TNCM:{ iata:'SXM', city:'St Maarten',        lat:18.041,  lon:-63.109 },
};

function lookupAirport(icao) {
  return AIRPORTS[icao?.toUpperCase()] || null;
}

// ── Manual route overrides ────────────────────────────────────────
const ROUTE_OVERRIDES = {
  NSZ5519: { origIcao: 'EKBI', destIata: 'BCN' },
  NSZ5520: { origIcao: 'LEBL', destIata: 'BLL' },
};

// ── Route lookup helpers ──────────────────────────────────────────
function buildRouteResult(origIcao, destIata, source) {
  const origAp = lookupAirport(origIcao);
  const destKey = Object.keys(AIRPORTS).find(k => AIRPORTS[k].iata === destIata) || '';
  const destAp  = destIata === 'BCN' ? { city: 'Barcelona' }
                : lookupAirport(destKey) || null;
  const result = {
    origin:          origAp?.iata  || null,
    originName:      origAp?.city  || null,
    originLat:       origAp?.lat   ?? null,
    originLon:       origAp?.lon   ?? null,
    destination:     destIata,
    destinationName: destAp?.city  || destIata,
  };
  if (result.origin) console.log(`Route (${source}) ${origIcao}: ${result.origin} → ${destIata}`);
  return result.origin ? result : null;
}

const routeCache = new Map();

async function lookupRouteVRS(callsign) {
  const prefix2 = callsign.substring(0, 2);
  try {
    const data = await fetchJson(
      `https://vrs-standing-data.adsb.lol/routes/${prefix2}/${callsign}.json`
    );
    if (!data?.airport_codes) return null;
    const [origIcao, ...rest] = data.airport_codes.split('-');
    const destIcao = rest[rest.length - 1];
    const destIata = data._airport_codes_iata?.split('-').pop()
                  || lookupAirport(destIcao)?.iata || destIcao;
    return buildRouteResult(origIcao, destIata, 'VRS');
  } catch { return null; }
}

async function lookupRoute(callsign) {
  const key = callsign.trim().toUpperCase();
  if (routeCache.has(key)) return routeCache.get(key);

  // 0. Manual overrides
  let result = null;
  if (ROUTE_OVERRIDES[key]) {
    const { origIcao, destIata } = ROUTE_OVERRIDES[key];
    result = buildRouteResult(origIcao, destIata, 'override');
  }

  // 1. VRS standing data
  if (!result) result = await lookupRouteVRS(key);

  // 2. adsbdb fallback
  if (!result) {
    try {
      const data = await fetchJson(`https://api.adsbdb.com/v0/callsign/${key}`);
      const fr = data?.response?.flightroute;
      if (fr?.origin?.icao_code) {
        const rawMunicipality = fr.origin?.municipality || '';
        const cleanCity = rawMunicipality.includes(',')
          ? rawMunicipality.split(',').pop().trim()
          : rawMunicipality;
        const origAp = lookupAirport(fr.origin.icao_code);
        result = {
          origin:          origAp?.iata  || fr.origin.iata_code || null,
          originName:      origAp?.city  || cleanCity || fr.origin.name || null,
          originLat:       origAp?.lat   ?? null,
          originLon:       origAp?.lon   ?? null,
          destination:     fr.destination?.iata_code || 'BCN',
          destinationName: fr.destination?.municipality || fr.destination?.name || 'Barcelona',
        };
        console.log(`Route (adsbdb) ${key}: ${result.origin} → ${result.destination}`);
      }
    } catch { /* no route */ }
  }

  routeCache.set(key, result);
  const ttl = result ? 3600000 : 3 * 60 * 1000;
  setTimeout(() => routeCache.delete(key), ttl);
  return result;
}

// ── Flight origin by hex (OpenSky historical — often 403 without auth) ──
const flightCache = new Map();

async function lookupFlightOrigin(hex) {
  const key = hex.toLowerCase();
  if (flightCache.has(key)) return flightCache.get(key);

  try {
    const now   = Math.floor(Date.now() / 1000);
    const begin = now - 7200; // look back 2 hours
    const data  = await fetchJson(
      `https://opensky-network.org/api/flights/aircraft?icao24=${key}&begin=${begin}&end=${now}`
    );
    const flights = Array.isArray(data) ? data : [];
    const latest  = flights[flights.length - 1];
    if (latest?.estDepartureAirport) {
      const origAp = lookupAirport(latest.estDepartureAirport);
      const result = {
        origin:      origAp?.iata || latest.estDepartureAirport,
        originName:  origAp?.city || latest.estDepartureAirport,
        originLat:   origAp?.lat  ?? null,
        originLon:   origAp?.lon  ?? null,
        departedAt:  latest.firstSeen || null,
        destination: 'BCN',
        destinationName: 'Barcelona',
      };
      flightCache.set(key, result);
      setTimeout(() => flightCache.delete(key), 3600000);
      return result;
    }
  } catch { /* 403 or no data */ }

  flightCache.set(key, null);
  setTimeout(() => flightCache.delete(key), 3 * 60 * 1000);
  return null;
}

// ── Aircraft operator name (OpenSky metadata — free, no auth) ────
const operatorCache = new Map();

async function lookupOperator(hex) {
  const key = hex.toLowerCase();
  if (operatorCache.has(key)) return operatorCache.get(key);
  try {
    const data = await fetchJson(
      `https://opensky-network.org/api/metadata/aircraft/icao/${key}`
    );
    const result = data?.owner ? { operator: data.owner } : null;
    operatorCache.set(key, result);
    setTimeout(() => operatorCache.delete(key), 7 * 24 * 3600 * 1000);
    return result;
  } catch {
    operatorCache.set(key, null);
    setTimeout(() => operatorCache.delete(key), 3600000);
    return null;
  }
}

// ── HTTP server ───────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // ── GET /api/runway ──────────────────────────────────────────────
  if (req.url === '/api/runway') {
    try {
      const info = await getActiveRunway();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(info));
    } catch(e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GET /api/aircraft ────────────────────────────────────────────
  if (req.url === '/api/aircraft') {
    try {
      const data = await fetchJson(ADSB_URL);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch(e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GET /api/photo/:hex ──────────────────────────────────────────
  const photoMatch = req.url.match(/^\/api\/photo\/([0-9a-f]+)$/i);
  if (photoMatch) {
    try {
      const photo = await lookupPhoto(photoMatch[1]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(photo));
    } catch(e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GET /api/flight/:hex ─────────────────────────────────────────
  const flightMatch = req.url.match(/^\/api\/flight\/([0-9a-f]+)$/i);
  if (flightMatch) {
    try {
      const origin = await lookupFlightOrigin(flightMatch[1]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(origin));
    } catch(e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GET /api/operator/:hex ───────────────────────────────────────
  const operatorMatch = req.url.match(/^\/api\/operator\/([0-9a-f]+)$/i);
  if (operatorMatch) {
    try {
      const op = await lookupOperator(operatorMatch[1]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(op));
    } catch(e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GET /api/route/:callsign ─────────────────────────────────────
  const routeMatch = req.url.match(/^\/api\/route\/([A-Z0-9]+)$/i);
  if (routeMatch) {
    try {
      const route = await lookupRoute(routeMatch[1]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(route));
    } catch(e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Static files ─────────────────────────────────────────────────
  const filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
    res.end(data);
  });

}).listen(PORT, () => {
  console.log(`✈  BCN Window Tracker → http://localhost:${PORT}`);
});
