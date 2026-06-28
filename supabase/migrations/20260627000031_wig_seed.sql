-- Faza 4: seed popularnych polskich spółek (WIG20 + mWIG40) + polskie ETF-y, z EODHD (giełda WAR).
-- Żeby polski user od razu widział blue chipy w pickerze bez „request asset". Reszta GPW i tak
-- dochodzi na żądanie przez /assets/discover + /assets/request.
--
-- asset_id = CODE.WAR (schemat nie-US: Code nieunikalny między giełdami; np. EUR.WAR = Eurocash,
-- NIE myli się z walutą EUR). api_source='eodhd', exchange='WAR' → fetch-eod wycenia bulkiem WAR.
-- api_symbol kładziemy = CODE.WAR (EODHD go nie czyta, ale kolumna NOT NULL).

insert into public.asset_definitions (asset_id, category, api_source, api_symbol, display_name, exchange, country) values
  ('ACP.WAR', 'stock', 'eodhd', 'ACP.WAR', 'Asseco Poland',          'WAR', 'Poland'),
  ('ALE.WAR', 'stock', 'eodhd', 'ALE.WAR', 'Allegro',                'WAR', 'Poland'),
  ('ALR.WAR', 'stock', 'eodhd', 'ALR.WAR', 'Alior Bank',             'WAR', 'Poland'),
  ('APR.WAR', 'stock', 'eodhd', 'APR.WAR', 'Auto Partner',           'WAR', 'Poland'),
  ('ATT.WAR', 'stock', 'eodhd', 'ATT.WAR', 'Grupa Azoty',            'WAR', 'Poland'),
  ('BDX.WAR', 'stock', 'eodhd', 'BDX.WAR', 'Budimex',                'WAR', 'Poland'),
  ('BFT.WAR', 'stock', 'eodhd', 'BFT.WAR', 'Benefit Systems',        'WAR', 'Poland'),
  ('BHW.WAR', 'stock', 'eodhd', 'BHW.WAR', 'Bank Handlowy',          'WAR', 'Poland'),
  ('CDR.WAR', 'stock', 'eodhd', 'CDR.WAR', 'CD Projekt',             'WAR', 'Poland'),
  ('CPS.WAR', 'stock', 'eodhd', 'CPS.WAR', 'Cyfrowy Polsat',         'WAR', 'Poland'),
  ('DNP.WAR', 'stock', 'eodhd', 'DNP.WAR', 'Dino Polska',            'WAR', 'Poland'),
  ('DOM.WAR', 'stock', 'eodhd', 'DOM.WAR', 'Dom Development',        'WAR', 'Poland'),
  ('DVL.WAR', 'stock', 'eodhd', 'DVL.WAR', 'Develia',                'WAR', 'Poland'),
  ('EUR.WAR', 'stock', 'eodhd', 'EUR.WAR', 'Eurocash',               'WAR', 'Poland'),
  ('JSW.WAR', 'stock', 'eodhd', 'JSW.WAR', 'Jastrzębska Spółka Węglowa', 'WAR', 'Poland'),
  ('KGH.WAR', 'stock', 'eodhd', 'KGH.WAR', 'KGHM Polska Miedź',      'WAR', 'Poland'),
  ('KRU.WAR', 'stock', 'eodhd', 'KRU.WAR', 'Kruk',                   'WAR', 'Poland'),
  ('KTY.WAR', 'stock', 'eodhd', 'KTY.WAR', 'Grupa Kęty',             'WAR', 'Poland'),
  ('LPP.WAR', 'stock', 'eodhd', 'LPP.WAR', 'LPP',                    'WAR', 'Poland'),
  ('LWB.WAR', 'stock', 'eodhd', 'LWB.WAR', 'Bogdanka',              'WAR', 'Poland'),
  ('MBK.WAR', 'stock', 'eodhd', 'MBK.WAR', 'mBank',                  'WAR', 'Poland'),
  ('MIL.WAR', 'stock', 'eodhd', 'MIL.WAR', 'Bank Millennium',       'WAR', 'Poland'),
  ('OPL.WAR', 'stock', 'eodhd', 'OPL.WAR', 'Orange Polska',          'WAR', 'Poland'),
  ('PCE.WAR', 'stock', 'eodhd', 'PCE.WAR', 'Grupa Azoty Police',     'WAR', 'Poland'),
  ('PCO.WAR', 'stock', 'eodhd', 'PCO.WAR', 'Pepco Group',            'WAR', 'Poland'),
  ('PEO.WAR', 'stock', 'eodhd', 'PEO.WAR', 'Bank Pekao',             'WAR', 'Poland'),
  ('PGE.WAR', 'stock', 'eodhd', 'PGE.WAR', 'PGE Polska Grupa Energetyczna', 'WAR', 'Poland'),
  ('PKN.WAR', 'stock', 'eodhd', 'PKN.WAR', 'Orlen',                  'WAR', 'Poland'),
  ('PKO.WAR', 'stock', 'eodhd', 'PKO.WAR', 'PKO Bank Polski',        'WAR', 'Poland'),
  ('PZU.WAR', 'stock', 'eodhd', 'PZU.WAR', 'PZU',                    'WAR', 'Poland'),
  ('TPE.WAR', 'stock', 'eodhd', 'TPE.WAR', 'Tauron Polska Energia',  'WAR', 'Poland'),
  ('TXT.WAR', 'stock', 'eodhd', 'TXT.WAR', 'Text',                   'WAR', 'Poland'),
  ('ZAB.WAR', 'stock', 'eodhd', 'ZAB.WAR', 'Żabka Group',            'WAR', 'Poland'),
  ('ZAP.WAR', 'stock', 'eodhd', 'ZAP.WAR', 'Grupa Azoty Puławy',     'WAR', 'Poland'),
  -- Polskie ETF-y (PZU)
  ('ETFPZUW20M40.WAR', 'etf', 'eodhd', 'ETFPZUW20M40.WAR', 'PZU ETF WIG20 TR & mWIG40', 'WAR', 'Poland'),
  ('ETFPZUWORLD.WAR',  'etf', 'eodhd', 'ETFPZUWORLD.WAR',  'PZU ETF MSCI World',         'WAR', 'Poland'),
  ('ETFPZUGOLD.WAR',   'etf', 'eodhd', 'ETFPZUGOLD.WAR',   'PZU ETF Gold',               'WAR', 'Poland')
on conflict (asset_id) do nothing;
