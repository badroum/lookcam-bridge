# Journal des modifications

## 0.3.1 — 2026-11-13

- Au démarrage de l'add-on, un premier tour lit toute la carte SD et récupère toutes les vidéos manquantes, de la plus ancienne à la plus récente. Viennent ensuite les tours réguliers, toutes les `interval_minutes`.
- Les tours réguliers ne lisent plus toute la liste de la carte SD. La caméra donne ses vidéos de la plus récente à la plus ancienne, donc la lecture s'arrête une page après la dernière vidéo déjà récupérée par l'add-on ou déjà présente sur le PC (`already_on_pc.txt`). En temps normal, un tour lit 1 à 3 pages au lieu de 200 : quelques secondes au lieu de 20 à 30 min. Le journal annonce à l'avance le nombre de pages estimé.
- Une lecture complète de la carte reste faite une fois par jour, pour rattraper un trou plus ancien éventuel (fichier en échec, tour interrompu).
- Nouvelle option `log_level` (`debug`, `info`, `warning`, `error` ; `info` par défaut) :
  - `info` affiche l'avancement de la lecture de la liste toutes les 10 pages (page, nombre de fichiers lus, date atteinte, durée), le bilan de la liste, le plan du tour (à télécharger, déjà sur le PC, déjà récupérés, en cours d'enregistrement, période couverte), chaque téléchargement avec son rang (ex. `[12/250]`), ce qui reste et une estimation du temps restant, puis un bilan en fin de tour ;
  - `debug` ajoute chaque page lue, chaque fichier ignoré avec sa raison et l'avancement du téléchargement en cours toutes les 15 s ;
  - les reprises (page sans réponse, caméra occupée, échec) sont en `warning`.
- Chaque ligne du journal indique son niveau (`INFO`, `WARN`, `ERROR`, `DEBUG`).

## 0.3.0 — 2026-11-11

- L'option `continuous` est supprimée. Tous les fichiers de la carte SD sont récupérés, quelle que soit leur durée (réglée dans l'application de la caméra), du plus ancien au plus récent. Seul le fichier en cours d'enregistrement est ignoré.
- Un seul dossier par jour, `/media/boite_aux_lettres/AAAA-MM-JJ/`. Le sous-dossier `continu/` n'est plus alimenté, mais les fichiers qui s'y trouvent déjà restent en place jusqu'à leur récupération par le PC.
- Le quota `max_gb` s'applique désormais à tous les fichiers. Une fois atteint, le tour s'arrête et la suite attend le tour suivant, le temps que le PC vide le partage.
- L'index des fichiers déjà récupérés garde maintenant 20 000 noms au lieu de 5 000, ce qui correspond à environ 40 jours de segments de 3 min.
- Si `continuous` figure encore dans ta configuration, le Supervisor l'ignore, et tu peux le retirer.

## 0.2.3 — 2026-11-11

- Chaque tour télécharge désormais les vidéos de la plus ancienne à la plus récente, clips courts et enregistrements continus mélangés. Avant, les clips courts partaient du plus récent. Le tri se fait sur l'heure contenue dans le nom du fichier (AAAAMMJJ-HHMMSS). La carte SD écrase ses fichiers les plus anciens en premier : ce sont eux qu'il faut sauver d'abord.
- Quand le quota disque (`max_gb`) est atteint, seuls les enregistrements continus attendent le tour suivant. Les clips courts continuent d'être téléchargés, alors qu'avant le tour s'arrêtait entièrement.

## 0.2.2 — 2026-11-11

- Une page de la liste de la carte SD qui ne répond pas est réessayée une fois sur une nouvelle session, puis ignorée. Avant, le tour entier s'arrêtait. Au-delà de 5 pages sans réponse, le tour continue avec la liste partielle.

## 0.2.1 — 2026-11-11

- Après un téléchargement bloqué, l'add-on libère le canal de téléchargement de la caméra (pause puis fermeture propre de la session).
- La réponse « occupée » de la caméra (state=3) n'est plus comptée comme un échec : l'add-on attend 1 min et réessaie, pendant 10 min au plus. Cela supprime la cascade d'erreurs « refused state=3 ».

## 0.2.0 — 2026-11-11

- Option `continuous` : récupère aussi les enregistrements continus dans `continu/AAAA-MM-JJ/`.
- Option `max_gb` : quota disque pour ces enregistrements.
- Les noms listés dans `already_on_pc.txt` (écrit par le PC) ne sont jamais téléchargés.

## 0.1.1 — 2026-11-10

- Mémorise les clips déjà récupérés dans `/data/fetched.json`, pour que le PC puisse les déplacer hors du Raspberry sans qu'ils soient téléchargés de nouveau.

## 0.1.0 — 2026-11-10

- Première version : téléchargement horaire des clips de la carte SD de la caméra vers `/media/boite_aux_lettres/`, et suppression des copies locales après `keep_days`. Image préconstruite, rien n'est compilé sur le Raspberry.
