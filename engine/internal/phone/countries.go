package phone

import "strings"

// e164Table is the ITU-T E.164 country calling code assignment list
// (ITU-T Operational Bulletin, "List of ITU-T Recommendation E.164 assigned
// country codes"), mapped to ISO 3166-1 alpha-2. Each line is
// "<prefix> <ISO>"; ISO "-" marks non-geographic / international network
// codes that have no country. Longer prefixes refine shared codes
// (e.g. +7 Russia vs +76/+77 Kazakhstan, +44 UK vs Crown Dependencies,
// +1 NANP by area code).
//
// Where ISO 3166-1 has no code for an ITU entity, the nearest ISO parent is
// used: Ascension (+247) -> SH; Kosovo (+383) uses the widely adopted
// user-assigned "XK".
const e164Table = `
1 US
20 EG
211 SS
212 MA
213 DZ
216 TN
218 LY
220 GM
221 SN
222 MR
223 ML
224 GN
225 CI
226 BF
227 NE
228 TG
229 BJ
230 MU
231 LR
232 SL
233 GH
234 NG
235 TD
236 CF
237 CM
238 CV
239 ST
240 GQ
241 GA
242 CG
243 CD
244 AO
245 GW
246 IO
247 SH
248 SC
249 SD
250 RW
251 ET
252 SO
253 DJ
254 KE
255 TZ
256 UG
257 BI
258 MZ
260 ZM
261 MG
262 RE
262269 YT
262639 YT
263 ZW
264 NA
265 MW
266 LS
267 BW
268 SZ
269 KM
27 ZA
290 SH
291 ER
297 AW
298 FO
299 GL
30 GR
31 NL
32 BE
33 FR
34 ES
350 GI
351 PT
352 LU
353 IE
354 IS
355 AL
356 MT
357 CY
358 FI
35818 AX
359 BG
36 HU
370 LT
371 LV
372 EE
373 MD
374 AM
375 BY
376 AD
377 MC
378 SM
379 VA
380 UA
381 RS
382 ME
383 XK
385 HR
386 SI
387 BA
389 MK
39 IT
3906698 VA
40 RO
41 CH
420 CZ
421 SK
423 LI
43 AT
44 GB
441481 GG
447781 GG
447839 GG
447911 GG
441534 JE
447509 JE
447700 JE
447797 JE
447829 JE
447937 JE
441624 IM
447524 IM
447624 IM
447924 IM
45 DK
46 SE
47 NO
4779 SJ
48 PL
49 DE
500 FK
501 BZ
502 GT
503 SV
504 HN
505 NI
506 CR
507 PA
508 PM
509 HT
51 PE
52 MX
53 CU
54 AR
55 BR
56 CL
57 CO
58 VE
590 GP
591 BO
592 GY
593 EC
594 GF
595 PY
596 MQ
597 SR
598 UY
599 CW
5993 BQ
5994 BQ
5997 BQ
60 MY
61 AU
6189162 CC
6189164 CX
62 ID
63 PH
64 NZ
65 SG
66 TH
670 TL
672 NF
6721 AQ
673 BN
674 NR
675 PG
676 TO
677 SB
678 VU
679 FJ
680 PW
681 WF
682 CK
683 NU
685 WS
686 KI
687 NC
688 TV
689 PF
690 TK
691 FM
692 MH
7 RU
76 KZ
77 KZ
800 -
808 -
81 JP
82 KR
84 VN
850 KP
852 HK
853 MO
855 KH
856 LA
86 CN
870 -
878 -
880 BD
881 -
882 -
883 -
886 TW
888 -
90 TR
91 IN
92 PK
93 AF
94 LK
95 MM
960 MV
961 LB
962 JO
963 SY
964 IQ
965 KW
966 SA
967 YE
968 OM
970 PS
971 AE
972 IL
973 BH
974 QA
975 BT
976 MN
977 NP
979 -
98 IR
991 -
992 TJ
993 TM
994 AZ
995 GE
996 KG
998 UZ
`

// NANP area codes outside the US mainland. Everything else under +1
// resolves to US. Sources: NANPA area code assignments (Canada, US
// territories and the Caribbean members of the plan).
var nanpAreas = map[string][]string{
	"CA": {
		"204", "226", "236", "249", "250", "257", "263", "289", "306", "343", "354",
		"365", "367", "368", "382", "403", "416", "418", "428", "431", "437", "438",
		"450", "460", "468", "474", "506", "514", "519", "548", "579", "581", "584",
		"587", "600", "604", "613", "622", "639", "647", "672", "683", "705", "709",
		"742", "753", "778", "780", "782", "807", "819", "825", "867", "873", "879",
		"902", "905", "942",
	},
	"BS": {"242"}, "BB": {"246"}, "AI": {"264"}, "AG": {"268"}, "VG": {"284"},
	"VI": {"340"}, "KY": {"345"}, "BM": {"441"}, "GD": {"473"}, "TC": {"649"},
	"JM": {"658", "876"}, "MS": {"664"}, "MP": {"670"}, "GU": {"671"}, "AS": {"684"},
	"SX": {"721"}, "LC": {"758"}, "DM": {"767"}, "VC": {"784"}, "PR": {"787", "939"},
	"DO": {"809", "829", "849"}, "TT": {"868"}, "KN": {"869"},
}

var (
	countryPrefixes map[string]string
	maxPrefixLen    int
)

func init() {
	countryPrefixes = make(map[string]string, 512)
	add := func(p, iso string) {
		if _, dup := countryPrefixes[p]; dup {
			panic("phone: duplicate prefix " + p)
		}
		countryPrefixes[p] = iso
		if len(p) > maxPrefixLen {
			maxPrefixLen = len(p)
		}
	}
	for _, line := range strings.Split(e164Table, "\n") {
		f := strings.Fields(line)
		if len(f) == 0 {
			continue
		}
		if len(f) != 2 {
			panic("phone: bad table line " + line)
		}
		iso := f[1]
		if iso == "-" {
			iso = ""
		}
		add(f[0], iso)
	}
	for iso, areas := range nanpAreas {
		for _, a := range areas {
			add("1"+a, iso)
		}
	}
}
