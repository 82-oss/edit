# events.py <tag> <media>: the scan's reads joined into events (one thing on screen from one frame to another), each classed
import sys,json,re,collections,difflib
STEP=10
STAMP=re.compile(r'\d{1,4}[/\-.]\d{1,2}[/\-.]\d{2,4}|\d{1,2}:\d{2}:\d{2}|BWC|AXON|\bX\d{5,}|\d{2}:\d{2}\s*(AM|PM|CST|EST|PST|MST|UTC|Z)\b',re.I)
def iou(a,b):
    w=min(a[2],b[2])-max(a[0],b[0]); h=min(a[3],b[3])-max(a[1],b[1])
    if w<=0 or h<=0: return 0
    return w*h/((a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-w*h)
def near(a,b,px=8): return all(abs(a[i]-b[i])<=px for i in range(4))
def sim(a,b): return difflib.SequenceMatcher(None,a.lower(),b.lower()).ratio()
def tracks(rows):
    live=[]; done=[]; prev=None
    for r in rows:
        f=r['f']
        if prev is not None and f-prev!=STEP:
            done+=live; live=[]
        nxt=[]; used=set()
        for L in r['lines']:
            box=L[:4]; best=None
            for i,t in enumerate(live):
                if i in used: continue
                lb=t['boxes'][-1]
                if near(box,lb) or (iou(box,lb)>0.6 and sim(L[4],t['texts'][-1])>0.6):
                    best=i; break
            if best is not None: live[best].pop('lost',None)
            if best is None: t={'f0':f,'boxes':[],'texts':[],'scores':[],'before':prev if prev is not None and f-prev==STEP else None}
            else: t=live[best]; used.add(best)
            t['boxes'].append(box); t['texts'].append(L[4]); t['scores'].append(L[5]); t['f1']=f; nxt.append(t)
        for i,t in enumerate(live):
            if i not in used:
                if 'lost' not in t: t['lost']=f
                if f-t['lost']>=2*STEP: t['after']=t.pop('lost'); done.append(t)
                else: nxt.append(t)
        live=nxt; prev=f
    done+=live
    for t in done:
        if 'lost' in t: t['after']=t.pop('lost')
        t.setdefault('after',None); b=t['boxes']
        t['box']=[min(x[0] for x in b),min(x[1] for x in b),max(x[2] for x in b),max(x[3] for x in b)]
        t['text']=collections.Counter(t['texts']).most_common(1)[0][0]; t['score']=max(t['scores']); t['n']=len(b)
        t['still']=all(near(x,b[0],6) for x in b)
    return sorted(done,key=lambda t:t['f0'])
def letters(s): return len(re.findall(r'[A-Za-z]',s))
def classify(ts,W=1920,H=1080,cut=lambda a,b:False):
    # their subtitles' band: where short-lived, centred, worded lines keep coming
    cand=[t for t in ts if t['n']<=40 and letters(t['text'])>=2 and t['score']>=0.6 and abs((t['box'][0]+t['box'][2])/2-W/2)<0.05*W]
    hist=collections.Counter(int((t['box'][1]+t['box'][3])/2/H*40) for t in cand)
    band=set(k for k,v in hist.items() if v>=max(8,0.05*len(cand)))
    band|={k+d for k in band for d in(-1,1)}
    places=collections.defaultdict(list)
    for t in ts: places[(re.sub(r'\W','',t['text'].lower()),t['box'][0]//16,t['box'][1]//16)].append(t)
    for t in ts:
        cy=int((t['box'][1]+t['box'][3])/2/H*40); cx=(t['box'][0]+t['box'][2])/2
        key=(re.sub(r'\W','',t['text'].lower()),t['box'][0]//16,t['box'][1]//16)
        if STAMP.search(t['text']): t['kind']='stamp'
        elif letters(t['text'])>=1 and t['n']<=90 and (cy in band or (abs(cx-W/2)<0.12*W and cy>=20 and t['still'] and t['score']>=0.5)): t['kind']='subtitle'
        elif letters(t['text'])>=3 and t['score']>=0.8 and (t['n']>=60 or sum(x['n'] for x in places[key])>=60) and t['still']: t['kind']='label'
        elif letters(t['text'])>=3 and t['score']>=0.8 and t['n']>=3 and t['still']: t['kind']='unsure'
        else: t['kind']='noise'
    return band
if __name__=='__main__':
    tag,mid=sys.argv[1],sys.argv[2]
    rows=[json.loads(l) for l in open(f'{tag}/scan/{mid}.jsonl')]
    ts=tracks(rows); band=classify(ts)
    for t in ts: del t['boxes'],t['texts'],t['scores']
    json.dump(ts,open(f'{tag}/scan/{mid}.events.json','w'))
    c=collections.Counter(t['kind'] for t in ts); s=collections.Counter()
    for t in ts: s[t['kind']]+=t['n']
    print(mid,'band rows /40:',sorted(band),dict(c),'reads:',dict(s))
    if '-v' in sys.argv:
        for k in ('label','unsure'):
            g=collections.Counter()
            for t in ts:
                if t['kind']==k: g[(t['text'][:40],tuple(x//20*20 for x in t['box']))]+=t['n']
            print(k); [print('  ',v,x) for x,v in g.most_common(40)]
        g=collections.Counter((t['text'][:30]) for t in ts if t['kind']=='noise' and t['score']>0.8 and letters(t['text'])>=3)
        print('noise worded',g.most_common(40))
