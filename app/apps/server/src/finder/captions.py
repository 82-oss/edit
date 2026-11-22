# captions.py <tag> <media>: the dense reads -> what to blur (their captions exact to a frame, their labels) -> <media>.masks.json
import sys,json,collections,numpy as np
from events import tracks as survey_tracks,near,iou,STAMP,letters
EVERY=2
def inside(b,s,gx=60,gy=14): return b[0]>=s[0]-gx and b[2]<=s[2]+gx and b[1]>=s[1]-gy and b[3]<=s[3]+gy
def cover(b,o):
    w=min(b[2],o[2])-max(b[0],o[0]); h=min(b[3],o[3])-max(b[1],o[1])
    return max(0,w)*max(0,h)/max(1,(b[2]-b[0])*(b[3]-b[1]))
def pad(b,W,H):
    h=b[3]-b[1]; py=max(6,0.12*h); px=0.3*h
    return [max(0,int(b[0]-px)),max(0,int(b[1]-py)),min(W,int(b[2]+px)),min(H,int(b[3]+py))]
def lines(bs):
    # word boxes on one row, close together, are one line
    bs=sorted(bs,key=lambda b:b[0]); out=[]
    for b in bs:
        for o in out:
            h=min(b[3]-b[1],o[3]-o[1]); oy=min(b[3],o[3])-max(b[1],o[1])
            if oy>0.5*h and b[0]-o[2]<1.5*max(b[3]-b[1],o[3]-o[1]):
                o[0]=min(o[0],b[0]); o[1]=min(o[1],b[1]); o[2]=max(o[2],b[2]); o[3]=max(o[3],b[3]); o[4]=max(o[4],b[4]); break
        else: out.append(list(b))
    return out
def captions(tag,mid,Z):
    """While a caption is on, every line of text touching it goes. A caption: a line in the zone, centred where the
    file's captions are, that holds its place for 2 reads or more and isn't a word of the scene."""
    import difflib,re
    W,H=Z['W'],Z['H']; out=[]
    if not Z['zone']: return out,[]
    keep=[s for s in Z['stamps']]+[L['box'] for L in Z['labels']]
    lo=0.55*Z['line'][0]; zy0=Z['zone'][0]*H-Z['line'][1]; zy1=Z['zone'][1]*H+Z['line'][1]
    c=Z.get('centre')
    # what the survey read where (to know a track's words without reading again)
    sv={}
    for l in open(f'{tag}/scan/{mid}.jsonl'):
        r=json.loads(l); sv[r['f']]=r['lines']
    def words(t):
        fa,fb=t['f'][0],t['f'][-1]; best=''
        for f in range(fa-fa%10,fb+10,10):
            for L in sv.get(f,[]):
                if cover(L,t['box'])>0.6 and len(L[4])>len(best): best=L[4]
        return best
    def scene(txt):
        ws=[re.sub(r'[^a-z]','',w.lower()) for w in txt.split()]
        ws=[w for w in ws if w]
        return bool(ws) and len(ws)<=2 and all(any(difflib.SequenceMatcher(None,w,g).ratio()>0.7 for g in Z.get('scene',[])) for w in ws)
    rows=[json.loads(l) for l in open(f'{tag}/scan/{mid}.dense.jsonl')]
    per=[]  # per read: f, lines
    live=[]; done=[]; prev=None
    for r in rows:
        f=r['f']
        L=[b for b in lines([b for b in r['b'] if not any(inside(b,s) for s in keep)]) if b[3]-b[1]>=lo and b[3]>zy0 and b[1]<zy1]
        per.append((f,L))
        if prev is not None and f-prev!=EVERY: done+=live; live=[]
        nxt=[]; used=set()
        for b in L:
            core=c is None or abs((b[0]+b[2])/2-c)<=0.06*W or (b[0]<c<b[2] and b[2]-b[0]>4*(b[3]-b[1]))
            if not core: continue
            best=None
            for i,t in enumerate(live):
                if i in used: continue
                if iou(b,t['b'][-1])>0.5 or cover(b,t['b'][-1])>0.7 or cover(t['b'][-1],b)>0.7: best=i; break
            if best is None: t={'b':[],'f':[]}
            else: t=live[best]; used.add(best)
            t['b'].append(b[:4]); t['f'].append(f); nxt.append(t)
        for i,t in enumerate(live):
            if i not in used:
                if f-t['f'][-1]>2*EVERY: done.append(t)
                else: nxt.append(t)
        live=nxt; prev=f
    done+=live
    on=collections.defaultdict(list)  # read frame -> caption boxes on
    for t in done:
        b=np.array(t['b']); t['box']=[int(b[:,0].min()),int(b[:,1].min()),int(b[:,2].max()),int(b[:,3].max())]
        t['n']=len(b); t['h']=float(np.median(b[:,3]-b[:,1])); cy=(b[:,1]+b[:,3])/2
        t['still']=bool(len(b)<3 or np.mean(np.abs(np.diff(cy))<=8)>=0.7); t['mid']=True
        t['text']=words(t); t['scene']=scene(t['text'])
        # a caption fused with a logo under it drifts with the logo: its words say it's a caption all the same
        t['ok']=t['n']>=2 and not t['scene'] and (t['still'] or letters(t['text'])>=4) and (t['f'][-1]-t['f'][0]<=20*30 or np.std(b[:,2]-b[:,0])>0.05*np.mean(b[:,2]-b[:,0]))   # on for long: captions follow one another (the line's width keeps changing); a sign in a still shot doesn't
        if t['ok']:
            for f,bb in zip(t['f'],t['b']): on[f].append(bb)
    fr=[f for f,_ in per]
    for i,(f,L) in enumerate(per):
        caps=[bb for j in range(max(0,i-2),min(len(per),i+3)) if abs(fr[j]-f)<=2*EVERY for bb in on.get(fr[j],[])]
        if not caps: continue
        take=list(caps); near_lines=[b[:4] for j in range(max(0,i-1),min(len(per),i+2)) if abs(fr[j]-f)<=EVERY for b in per[j][1]]
        grew=True
        while grew:
            grew=False
            for b in near_lines:
                if b in take: continue
                h=b[3]-b[1]
                if any(min(b[2],t[2])-max(b[0],t[0])>-h and min(b[3],t[3])-max(b[1],t[1])>-0.6*h for t in take): take.append(b); grew=True
        # never taller than 3 lines of this file's captions (a caption fused with a shirt's logo reads as one tall box)
        top=min(b[1] for b in take); bot=max(b[3] for b in take); maxh=3.3*Z['line'][2]
        if bot-top>maxh:
            ccy=np.median([(b[1]+b[3])/2 for b in caps if b[3]-b[1]<=1.6*Z['line'][2]] or [(top+bot)/2]); top=max(top,ccy-maxh/2); bot=min(bot,ccy+maxh/2)
        x0=min(b[0] for b in take); y0=max(zy0,top); x1=max(b[2] for b in take); y1=min(zy1,bot)
        if c is not None:
            r=max(c-x0,x1-c)
            if r<0.48*W: x0=min(x0,c-r); x1=max(x1,c+r)
        m=[f-1,f+1,*pad([int(x0),int(y0),int(x1),int(y1)],W,H),'subtitle']
        if out and out[-1][1]>=f-1 and out[-1][2:6]==m[2:6]: out[-1][1]=f+1
        else: out.append(m)
    return out,done
def labels(tag,mid,Z):
    W,H=Z['W'],Z['H']; out=[]
    if not Z['labels']: return out
    ts=survey_tracks([json.loads(l) for l in open(f'{tag}/scan/{mid}.jsonl')])
    for L in Z['labels']:
        for t in ts:
            if near(t['box'],L['box'],40) or cover(t['box'],L['box'])>0.6:
                a=t['before']+1 if t['before'] is not None else t['f0']-9
                b=t['after']-1 if t['after'] is not None else t['f1']+9
                out.append([a,b,*pad(L['box'],W,H),'label'])
    return out
if __name__=='__main__':
    tag,mid=sys.argv[1],sys.argv[2]; Z=json.load(open(f'{tag}/scan/{mid}.zone.json'))
    cap,done=captions(tag,mid,Z) if Z['zone'] else ([],[]); lab=labels(tag,mid,Z)
    json.dump(cap+lab,open(f'{tag}/scan/{mid}.masks.json','w'))
    rej=[t for t in done if not t['ok'] and t['n']>=4]
    print(mid,'captions',len(cap),'label spans',len(lab),'| read but not taken (4+ reads):',len(rej),' not still:',sum(not t['still'] for t in rej),' scene word:',sum(t['scene'] for t in rej),sorted({t['text'] for t in rej if t['scene']})[:12])
