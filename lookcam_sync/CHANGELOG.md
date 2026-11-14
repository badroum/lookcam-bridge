# Journal des modifications

## 0.5.4 — 2026-11-14

- Enchaînement après un long tour : un tour ne récupère que les vidéos présentes au moment où il a lu la carte. Après un rattrapage de plusieurs heures, les vidéos enregistrées pendant ce temps attendaient en plus l'intervalle complet, si bien que la synchro semblait arrêtée. Désormais, si un tour a duré plus de la moitié de l'intervalle, le suivant démarre au bout d'une minute. Les tours réguliers, courts, gardent l'intervalle normal.
- Le journal l'indique : « Round N took X min: recordings made meanwhile are fetched now, next sync at HH:MM (in 1 min) ».
- Démarrage plus rapide : au démarrage ou après une mise à jour, l'add-on ne relit plus toute la carte SD (environ 6 min). Il lit la liste seulement jusqu'à la dernière vidéo récupérée, grâce au repère `complete_until.txt`. La lecture complète reste faite une fois par jour, ou quand rien n'est encore connu.
- Indicateurs de synchro :
  - le journal indique à la fin de chaque tour « status: up to date » ou « status: N recording(s) still to fetch, X min behind the camera » ;
  - deux capteurs Home Assistant, mis à jour au plus une fois par minute pendant un tour : `sensor.lookcam_sync_retard` (minutes de retard sur la caméra) et `sensor.lookcam_sync_en_attente` (vidéos à récupérer). Attributs : à jour, phase, tour, type de tour, dernière vidéo récupérée, dernière vidéo sur la caméra, fin estimée, échecs, dernière erreur, prochain tour, version ;
  - nouvelle route `GET /status` (avec jeton) sur le serveur de fichiers, pour le PC.
- Ces capteurs sont recréés par l'add-on : après un redémarrage de Home Assistant, ils réapparaissent au tour suivant.

## 0.5.3 — 2026-11-14

- Le rattrapage ne s'arrête plus pendant qu'un mouvement attend la fin de son segment. Avant, l'add-on restait en pause plusieurs minutes (le segment de 5 min doit être fermé par la caméra avant d'apparaître dans la liste).
- Les mouvements en attente sont gardés dans une liste. La liste de la carte SD est relue toutes les 60 s pour chacun ; entre deux vérifications, les téléchargements du tour continuent.
- La pause du téléchargement en cours (state 2, reprise sur le fichier `.part`) ne se fait plus que le temps d'une vérification ou du téléchargement du segment de mouvement.
- Les mouvements encore en attente à la fin d'un tour sont remis dans la file et repris par la boucle d'attente entre deux tours.

## 0.5.2 — 2026-11-14

- Un mouvement de la boîte aux lettres n'attend plus la fin du tour en cours. Avant, l'add-on ne lisait les demandes de Home Assistant qu'entre deux tours : pendant un rattrapage de plusieurs heures (après une mise à jour), aucune vidéo de mouvement n'était récupérée.
- Les demandes reçues par `hassio.addon_stdin` sont lues en continu et mises en file d'attente dans `/data/motion_queue`.
- Pendant un tour, la file est consultée avant chaque vidéo. Un téléchargement en cours est mis en pause proprement (state 2) dès qu'un mouvement arrive, le mouvement est servi sur la même session caméra, puis le téléchargement reprend là où il s'était arrêté (fichier `.part`).
- Le téléchargement d'une vidéo de mouvement n'est jamais interrompu par un autre mouvement : les suivants attendent dans la file. Les doublons d'une même heure sont fusionnés.
- Entre deux tours, la file est vérifiée toutes les 5 s.
- Limite connue : pendant la lecture de la liste de la carte SD (quelques minutes au démarrage), le mouvement attend la fin de la lecture. Le segment de 3 min doit de toute façon être terminé avant d'être récupéré.

## 0.5.1 — 2026-11-14

- Lecture complète de la carte SD (au démarrage et une fois par jour) : la deuxième passe n'est faite que si le nombre de fichiers annoncé par la caméra a changé pendant la première, ou si une page n'a pas répondu. Sinon, une seule passe suffit, ce qui fait gagner environ 1 min 30 au démarrage.
- Le journal indique la raison de la deuxième passe, ou « no second pass needed ».

## 0.5.0 — 2026-11-14

- Nouvelle option `pc_transfer` pour choisir comment le PC récupère les vidéos : `samba` (par défaut, comme avant, avec l'add-on Samba) ou `http` (serveur de fichiers intégré, plus léger sur un Raspberry Pi 3, l'add-on Samba peut alors être arrêté).
- Le serveur de fichiers démarre seulement avec `pc_transfer: http` et un `http_token` d'au moins 16 caractères. Le port se règle avec `http_port` (8099 par défaut). Il n'écoute que sur le réseau local, et chaque requête doit porter l'en-tête `Authorization: Bearer <jeton>`.
- Routes :
  - `GET /list` : `{"files":[{"day","name","size","mtime"}],"parts":["jour/nom"]}`, les vidéos terminées et les téléchargements en cours ;
  - `GET /file/<jour>/<nom>` : téléchargement, avec reprise (`Range`) ;
  - `POST /done` avec `{"files":["jour/nom"]}` ou `{"files":[{"day","name","size"}]}` : supprime du Pi les vidéos que le PC a copiées (si une taille est donnée, seulement si elle correspond) ;
  - `POST /have` avec `{"names":[...]}` (ou `PUT /have`, un nom par ligne) : remplace `already_on_pc.txt` ;
  - `GET /health` : test sans jeton.
- Avec `pc_transfer: samba`, rien ne change.

## 0.4.1 — 2026-11-14

- Décrochages de la liaison avec la caméra : un transfert est jugé bloqué après 15 s sans données, au lieu de 30 s. L'add-on rouvre alors la session tout de suite (1 s au lieu de 10 s) et reprend au même octet.
- Un décrochage survenu après que le fichier a avancé ne compte plus comme une tentative échouée (jusqu'à 20 décrochages par fichier). Un fichier qui décroche plusieurs fois n'est donc plus abandonné jusqu'au tour suivant.
- Le journal l'indique : « transfer dropped …, reconnecting and resuming (drop N) ». La durée affichée pour chaque vidéo compte les reconnexions.

## 0.4.0 — 2026-11-13

- Récupération sur mouvement : Home Assistant envoie l'heure d'un mouvement (capteur de la boîte aux lettres) à l'add-on avec le service `hassio.addon_stdin`, au format `AAAAMMJJHHMMSS` (heure locale). Exemple : `input: "{{ now().strftime('%Y%m%d%H%M%S') }}"`.
- L'add-on attend que le segment qui couvre cette heure soit terminé sur la carte SD (12 min au plus, vérification chaque minute), puis le télécharge dans `/media/boite_aux_lettres_mouvements/AAAA-MM-JJ/`. Si le mouvement tombe dans les 20 dernières secondes d'un segment, le suivant est pris aussi.
- Ce dossier est à part : il n'est ni purgé (`keep_days`), ni compté dans `max_gb`, ni vidé par le PC. Les vidéos de mouvement y restent indéfiniment.
- Une fois la vidéo sur le Pi, l'add-on déclenche l'événement Home Assistant `lookcam_sync_mouvement` avec `heure`, `ok`, `fichiers` (chemins relatifs à `/media`), `jour` et `dossier`. En cas d'échec, `ok` vaut `false` et `erreur` donne la raison.
- Le tour régulier copie depuis ce dossier, sans la retélécharger, une vidéo déjà récupérée pour un mouvement : le PC la reçoit comme les autres.
- Un mouvement reçu pendant un tour régulier attend la fin de ce tour (une seule session avec la caméra à la fois).

## 0.3.2 — 2026-11-13

- L'option `log_level` apparaît maintenant directement dans l'onglet Configuration de l'add-on (`info` par défaut). Avant, Home Assistant la masquait parce qu'elle était facultative.
- Le journal indique quand l'add-on démarre : version, adresse de la caméra, intervalle, niveau de journal, quota et durée de conservation. Il indique aussi « LookCam Sync stopping » à l'arrêt.
- Chaque tour est numéroté et son type est précisé : « Round 1 (start-up, full catch-up) », puis « Round 2 (regular) »…
- En fin de tour, le journal donne l'heure du tour suivant, par exemple « Next sync at 21:54 (in 60 min) ».
- Nouvelle option `download_order` pour choisir l'ordre des téléchargements :
  - `oldest_first` (par défaut, comportement actuel) : du plus ancien au plus récent, car la carte SD écrase ses fichiers les plus anciens en premier ;
  - `newest_first` : du plus récent au plus ancien. Les dernières vidéos arrivent d'abord, l'arriéré ensuite. Attention : pendant un long rattrapage, les plus anciennes peuvent être écrasées par la caméra avant d'être récupérées.
- L'add-on retient maintenant jusqu'où tout est récupéré (`/data/complete_until.txt`). Un tour régulier relit la carte jusqu'à ce point, et pas seulement jusqu'à la dernière vidéo récupérée. Ainsi, avec `newest_first`, ou quand le quota arrête un tour, les vidéos plus anciennes encore en attente ne sont pas oubliées.

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
