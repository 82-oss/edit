# zone.py: from a file's survey, where its captions come and go (rows of the picture), its labels' and stamps' places
import json,re,collections,cv2
from events import STAMP,letters,tracks,near
AXON=re.compile(r'AX[O0]N|B[O0]DY ?\d|\b[XD]\d[0-9A-Z]{6,}\b|BWC|MOTOROLA|WATCHGUARD',re.I)
def size(tag,mid):
    c=cv2.VideoCapture(f'{tag}/src/{mid}.mp4'); return int(c.get(3)),int(c.get(4)),c.get(5)
def survey(tag,mid):
    W,H,fps=size(tag,mid)
    rows=[json.loads(l) for l in open(f'{tag}/scan/{mid}.jsonl')]
    ts=tracks(rows)
    for t in ts: t['stamp']=bool(STAMP.search(t['text']) or AXON.search(t['text']))
    # stamps' places: where a stamp was read, grown a little; anything read there is the camera's
    stamps=[]
    for t in ts:
        if t['stamp'] and not any(near(t['box'],s,40) for s in stamps): stamps.append(t['box'])
    def instamp(b): return any(b[0]>=s[0]-60 and b[2]<=s[2]+60 and b[1]>=s[1]-12 and b[3]<=s[3]+12 for s in stamps)
    # labels: the same words in the same place for 20 s or more in all
    places=collections.defaultdict(int)
    for t in ts:
        if not t['stamp'] and letters(t['text'])>=3 and t['still']: places[(re.sub(r'[^a-z]','',t['text'].lower()),t['box'][0]//24,t['box'][1]//24)]+=t['n']
    labels=[]
    for t in ts:
        k=(re.sub(r'[^a-z]','',t['text'].lower()),t['box'][0]//24,t['box'][1]//24)
        if places.get(k,0)>=60 and not instamp(t['box']) and t['score']>=0.8:
            for L in labels:
                if near(L['box'],t['box'],30): L['box']=[min(L['box'][0],t['box'][0]),min(L['box'][1],t['box'][1]),max(L['box'][2],t['box'][2]),max(L['box'][3],t['box'][3])]; L['texts'][t['text']]+=t['n']; break
            else: labels.append({'box':list(t['box']),'texts':collections.Counter({t['text']:t['n']})})
    def inlabel(b): return any(near(b,L['box'],40) for L in labels)
    cap=[t for t in ts if not t['stamp'] and not instamp(t['box']) and not inlabel(t['box']) and t['still'] and 2<=t['n']<=30 and letters(t['text'])>=3 and t['score']>=0.85]
    hist=collections.Counter(); hs=[]
    for t in cap:
        for r in range(int(t['box'][1]/H*40),int(t['box'][3]/H*40)+1): hist[r]+=t['n']
        hs.append(t['box'][3]-t['box'][1])
    tot=sum(hist.values()) or 1
    keep=sorted(r for r,v in hist.items() if v>=0.02*tot)
    shown=sum(b-a for a,b,*_ in json.load(open(f'{tag}/shown.json'))[mid])
    zone=[max(0,(keep[0]-1)/40),min(1,(keep[-1]+2)/40)] if keep and len(cap)>=8*shown/60 else None
    hs.sort()
    # words of the scene: read again and again (a shirt, a vest, a sign), never a caption's sentence
    import difflib
    cnt=collections.Counter(); cells=collections.defaultdict(set)
    for t in ts:
        k=re.sub(r'[^a-z]','',t['text'].lower())
        if len(k)>=3 and not t['stamp'] and not inlabel(t['box']): cnt[k]+=t['n']; cells[k].add((t['box'][0]//80,t['box'][1]//80))
    scene=[]
    for k,v in cnt.most_common(80):
        if v<15: break
        for g in scene:
            if difflib.SequenceMatcher(None,k,g[0]).ratio()>0.7: g[1]+=v; g[2]|=cells[k]; break
        else: scene.append([k,v,set(cells[k])])
    # in many places: a caption's note ("(Unintelligible)") comes back too, but always where captions are
    scene=[g[0] for g in scene if g[1]>=40 and len(g[2])>=8]
    cxs=sorted((t['box'][0]+t['box'][2])/2 for t in cap if t['box'][2]-t['box'][0]>3*(t['box'][3]-t['box'][1]))
    centre=None
    if len(cxs)>=20:
        med=cxs[len(cxs)//2]
        if sum(abs(x-med)<0.02*W for x in cxs)>=0.8*len(cxs): centre=med
    return {'W':W,'H':H,'fps':fps,'zone':zone,'centre':centre,'scene':scene,'line':[hs[len(hs)//20],hs[len(hs)//2],hs[-len(hs)//20-1]] if hs else None,'captions':len(cap),'stamps':stamps,'labels':[{'box':L['box'],'text':L['texts'].most_common(1)[0][0],'n':sum(L['texts'].values())} for L in labels]}
if __name__=='__main__':
    import sys
    for m in sys.argv[2:]:
        s=survey(sys.argv[1],m); json.dump(s,open(f'{sys.argv[1]}/scan/{m}.zone.json','w'))
        print(m,s['W'],s['H'],'zone',s['zone'],'centre',s['centre'],'line h',s['line'],'captions',s['captions'],'scene words',s['scene'],'\n   stamps',s['stamps'],'\n   labels',[(L['text'],L['box'],L['n']) for L in s['labels']])
