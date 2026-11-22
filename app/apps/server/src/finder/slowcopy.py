# copy.py <tag> <copy media> <parent media>: a slowed copy of a stretch of a file: what its parent taught (zone, labels,
# marks) applied to the copy's own reads -> <copy>.masks.json
import sys,json,re,difflib,subprocess,os
from captions import captions,pad
tag,mid,par=sys.argv[1:4]
Z=json.load(open(f'{tag}/scan/{par}.zone.json')); W,H=Z['W'],Z['H']
if 'pre' in sys.argv:
    json.dump(Z,open(f'{tag}/scan/{mid}.zone.json','w')); sys.exit()
ms=captions(tag,mid,Z)[0] if Z['zone'] and os.path.exists(f'{tag}/scan/{mid}.dense.jsonl') else []
rows=[json.loads(l) for l in open(f'{tag}/scan/{mid}.jsonl')]
last=rows[-1]['f'] if rows else 0
import assemble
V=json.load(open(f'{tag}/verdicts.json')).get(par,[]); ask=assemble.ask_list(tag,par)
VV=json.load(open(f'{tag}/verdicts.json')); okl=VV.get(par+':labels')
marks=[m for m in json.load(open(f'{tag}/scan/{par}.marks.json')) if m['kind'] in('label','roamer') and (okl is None or m['key'] in okl)]
_labels=[m['key'] for m in marks if m['kind']=='label']
marks=[m for m in marks if m['kind']=='label' or not any(m['key'] in k or difflib.SequenceMatcher(None,m['key'],k).ratio()>0.55 for k in _labels)]+[dict(c['mark'],kind='label') for c in ask if c['kind']=='unsure' and any(y[0]=='unsure' and y[1]==c['text'] for y in V)]
for m in marks:
    hits=[]
    for r in rows:
        for L in r['lines']:
            k=re.sub(r'[^a-z0-9]','',L[4].lower())
            if len(k)>=3 and (difflib.SequenceMatcher(None,k,m['key']).ratio()>0.6 or (len(k)>=4 and k in m['key'])): hits.append([r['f'],*L[:4]])
    whole=[b for b in assemble.label_masks(Z,[m]) if b[1]>=10**9] if m['kind']=='label' else []
    if whole: ms.append([-1,last+12,*whole[0][2:6],'label']); continue
    if not hits: continue
    if m['kind']=='label':
        # its place as the parent knows it, on for the whole copy
        for b in assemble.label_masks(Z,[m]):
            if any(abs(b[2]-h[1])<80 and abs(b[3]-h[2])<60 for h in hits): ms.append([-1,last+12,*b[2:6],'label']); break
        else:
            x0=min(h[1] for h in hits); y0=min(h[2] for h in hits); x1=max(h[3] for h in hits); y1=max(h[4] for h in hits)
            if x1-x0<2.2*m['w']: ms.append([-1,last+12,*pad([x0,y0,x1,y1],W,H),'label'])
    else:
        # the mark's path in the copy: from the copy's own sightings, held to both ends of the copy (it's a few seconds long)
        import glide
        e=json.load(open(f'{tag}/scan/{par}.roam.ext.json')) if os.path.exists(f'{tag}/scan/{par}.roam.ext.json') else [-int(0.55*m['w']),-int(0.9*m['h']),int(0.55*m['w']),int(0.9*m['h'])]
        if (e[2]-e[0])*(e[3]-e[1])>5*m['w']*m['h'] or e[2]-e[0]>1.7*m['w']: e=[-int(0.55*m['w']),-int(0.9*m['h']),int(0.55*m['w']),int(0.9*m['h'])]
        A=glide.anchors(tag,mid,m,[f'{tag}/scan/{mid}.jsonl'])
        if A: ms+=glide.path(A,W,H,e,lo=-1,hi=last+12)[0]
# the copy's own one-off words (a narration line of theirs in just this stretch): candidates for the judge, kept when said yes
json.dump([dict(m,reads=[]) for m in json.load(open(f'{tag}/scan/{par}.marks.json'))],open(f'{tag}/scan/{mid}.marks.json','w'))
import cands
cs=cands.cands(tag,mid); json.dump(cs,open(f'{tag}/scan/{mid}.cands.json','w'))
yes=json.load(open(f'{tag}/verdicts.json')).get(mid,[]) if os.path.exists(f'{tag}/verdicts.json') else []
for c in cs:
    if any(y[1]==c['text'] for y in yes):
        rs=c['reads']; b=pad([min(r[1] for r in rs),min(r[2] for r in rs),max(r[3] for r in rs),max(r[4] for r in rs)],W,H); ex=int(0.5*(b[3]-b[1]))
        ms.append([rs[0][0]-10,rs[-1][0]+10,max(0,b[0]-ex),b[1],min(W,b[2]+ex),b[3],'note'])
json.dump(ms,open(f'{tag}/scan/{mid}.masks.json','w'))
import collections; print(mid,'of',par,dict(collections.Counter(x[6] for x in ms)))
